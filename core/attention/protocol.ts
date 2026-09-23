import { buildUserContent, type ImageAttachment } from "./content.ts";
import type { MakeTransport, Transport } from "./transport.ts";
import { modelEntriesFromWire, reasoningEffortFromSettings, type AppliedModel, type ModelEntry, type ModelSelection } from "../models.ts";
/**
 * Client for Letta's app-server protocol, reached through the mod's
 * /appserver tunnel (the app-server itself refuses browser origins). Requests
 * correlate by request_id; everything else fans out as events.
 * Docs: https://docs.letta.com/platform/app-server/protocol-lifecycle
 */
export interface Runtime {
  agent_id: string;
  conversation_id: string;
}
export type ServerEvent = Record<string, unknown> & { type: string; runtime?: Runtime };

/** Letta's sleep-time reflection: when a pass fires and how its changes land (ReflectionSettingsSnapshot, in loki's casing). */
export type ReflectionTrigger = "off" | "step-count" | "compaction-event";
export type ReflectionMerge = "auto" | "explicit";
export interface ReflectionSettings {
  trigger: ReflectionTrigger;
  /** Steps a conversation accumulates since its last pass before the step-count trigger fires. */
  stepCount: number;
  merge: ReflectionMerge;
  mergeInstructions: string;
}
export function parseReflectionSettings(v: unknown): ReflectionSettings | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const trigger = o.trigger === "off" || o.trigger === "step-count" || o.trigger === "compaction-event" ? o.trigger : "step-count";
  return { trigger, stepCount: typeof o.step_count === "number" && o.step_count > 0 ? Math.floor(o.step_count) : 25, merge: o.merge === "explicit" ? "explicit" : "auto", mergeInstructions: typeof o.merge_instructions === "string" ? o.merge_instructions : "" };
}

/** One credential the harness asks for when connecting a provider. */
export interface ProviderField {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  required?: boolean;
}
export interface ProviderAuthMethod {
  id: string;
  label: string;
  description?: string;
  fields: ProviderField[];
}
/** An entry of list_connect_providers. */
export interface ConnectProvider {
  id: string;
  display_name: string;
  description?: string;
  provider_type: string;
  provider_name: string;
  is_oauth?: boolean;
  oauth_provider_id?: string;
  requires_api_key: boolean;
  fields?: ProviderField[];
  auth_methods?: ProviderAuthMethod[];
  connected: { is_connected: boolean; id?: string; provider_name?: string; provider_type?: string; auth_type?: string };
}
/** Letta's personality presets accepted by create_agent. */
export type Personality = "memo" | "blank" | "tutorial" | "linus" | "kawaii";
export const PERSONALITIES: Array<{ id: Personality; label: string; description: string }> = [
  { id: "memo", label: "Letta Code", description: "the memory-first coding agent; what `letta` itself creates" },
  { id: "blank", label: "Blank", description: "no personality written; you or the agent fill in persona.md" },
  { id: "tutorial", label: "Tutor", description: "knows Letta, helps set up and configure agents" },
  { id: "linus", label: "Linus", description: "terse and exacting" },
  { id: "kawaii", label: "Kawaii", description: "cheerful" },
];
type Listener = (ev: ServerEvent) => void;

export class AppServerSocket {
  private transport: Transport | null = null;
  private pending = new Map<string, { resolve: (v: ServerEvent) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<Listener>();
  private runtimes = new Map<string, Runtime>();
  private opening: Promise<void> | null = null;
  private closed = false;
  private retryMs = 500;
  readonly url: string;
  private readonly makeTransport: MakeTransport;
  onStatus?: (s: "connecting" | "open" | "closed") => void;

  constructor(url: string, makeTransport: MakeTransport) {
    this.url = url;
    this.makeTransport = makeTransport;
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  connect(): Promise<void> {
    if (this.opening) return this.opening;
    this.onStatus?.("connecting");
    this.opening = new Promise<void>((resolve, reject) => {
      const transport = this.makeTransport(this.url);
      this.transport = transport;
      let settled = false;
      transport.open({
        onOpen: () => {
          settled = true;
          this.retryMs = 500;
          this.onStatus?.("open");
          resolve();
          for (const rt of this.runtimes.values()) void this.runtimeStart(rt).catch(() => {});
        },
        onMessage: (raw) => this.onMessage(raw),
        onError: (err) => {
          if (!settled) {
            settled = true;
            reject(err);
          }
        },
        onClose: () => {
          this.onStatus?.("closed");
          for (const p of this.pending.values()) {
            clearTimeout(p.timer);
            p.reject(new Error("app-server link closed"));
          }
          this.pending.clear();
          if (this.closed) return;
          if (transport.reconnects) return; // the link (the Rust core, say) reconnects on its own and will report "open" again
          this.transport = null;
          this.opening = null;
          setTimeout(() => void this.connect().catch(() => {}), this.retryMs);
          this.retryMs = Math.min(this.retryMs * 2, 8000);
        },
      });
    });
    return this.opening;
  }

  close(): void {
    this.closed = true;
    this.transport?.close();
  }

  private onMessage(raw: string): void {
    let m: ServerEvent;
    try {
      m = JSON.parse(raw) as ServerEvent;
    } catch {
      return;
    }
    const rid = typeof m.request_id === "string" ? m.request_id : null;
    if (rid && this.pending.has(rid)) {
      const p = this.pending.get(rid)!;
      this.pending.delete(rid);
      clearTimeout(p.timer);
      p.resolve(m);
      return;
    }
    for (const fn of this.listeners) fn(m);
  }

  async request(type: string, payload: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<ServerEvent> {
    await this.connect();
    const request_id = `${type}-${Math.random().toString(36).slice(2, 10)}`;
    return new Promise<ServerEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request_id);
        reject(new Error(`${type} timed out`));
      }, timeoutMs);
      this.pending.set(request_id, { resolve, reject, timer });
      this.transport!.send(JSON.stringify({ type, request_id, ...payload }));
    });
  }

  async runtimeStart(rt: Runtime, opts: { mode?: string } = {}): Promise<ServerEvent> {
    const key = `${rt.agent_id}/${rt.conversation_id}`;
    this.runtimes.set(key, rt);
    const res = await this.request("runtime_start", {
      agent_id: rt.agent_id,
      conversation_id: rt.conversation_id,
      // `mode` only when the user asked for a change here: runtime_start is how the app-server sets the
      // permission mode for a conversation, so sending it unasked would override what was picked in Desktop.
      ...(opts.mode ? { mode: opts.mode } : {}),
      client_info: { name: "loki", title: "loki canvas", version: "0.2.0" },
      recover_approvals: false,
    });
    if (res.success === false) {
      this.runtimes.delete(key);
      throw new Error(typeof res.error === "string" ? res.error : "runtime_start failed");
    }
    return res;
  }

  /** Answer an AskUserQuestion: an allow decision carrying the tool input with `answers` filled in. */
  async answerQuestion(rt: Runtime, requestId: string, updatedInput: Record<string, unknown>): Promise<boolean> {
    try {
      const res = await this.request("input", { runtime: rt, payload: { kind: "approval_response", request_id: requestId, decision: { behavior: "allow", updated_input: updatedInput } } });
      const ok = res.type === "input_accepted" && res.success !== false && (res as { accepted?: boolean }).accepted !== false;
      if (!ok) console.warn("loki: answer not accepted", res);
      return ok;
    } catch (err) {
      console.warn("loki: answer failed", err);
      return false;
    }
  }

  /** Start a brand-new conversation for an agent in `cwd`; returns its runtime. */
  async createConversation(agentId: string, cwd: string, name?: string): Promise<Runtime> {
    const res = await this.request("runtime_start", {
      agent_id: agentId,
      create_conversation: { body: name?.trim() ? { summary: name.trim() } : {} },
      cwd,
      client_info: { name: "loki", title: "loki canvas", version: "0.2.0" },
      recover_approvals: false,
    });
    if (res.success === false) throw new Error(typeof res.error === "string" ? res.error : "could not create the conversation");
    const rt = res.runtime as Runtime | undefined;
    if (!rt?.conversation_id) throw new Error("the server returned no conversation");
    this.runtimes.set(`${rt.agent_id}/${rt.conversation_id}`, rt);
    return rt;
  }

  isSubscribed(rt: Runtime): boolean {
    return this.runtimes.has(`${rt.agent_id}/${rt.conversation_id}`);
  }

  /** agent_update: name, description, model (the local backend accepts the record's own fields). */
  async updateAgent(agentId: string, body: Record<string, unknown>): Promise<void> {
    const res = await this.request("agent_update", { agent_id: agentId, body });
    if (res.success === false) throw new Error(String(res.error ?? "agent update refused"));
  }

  // --- sleep-time reflection: Letta's per-agent settings, addressed through one of the agent's conversations ------
  async getReflectionSettings(rt: Runtime): Promise<ReflectionSettings | null> {
    const res = await this.request("get_reflection_settings", { runtime: rt });
    if (res.success === false) throw new Error(String(res.error ?? "reflection settings refused"));
    return parseReflectionSettings(res.reflection_settings);
  }
  /** Written to Letta's global settings (its per-agent table), the scope the /sleeptime overlay writes too. */
  async setReflectionSettings(rt: Runtime, s: { trigger: ReflectionTrigger; stepCount: number; merge: ReflectionMerge; mergeInstructions?: string }): Promise<ReflectionSettings | null> {
    const res = await this.request("set_reflection_settings", { runtime: rt, settings: { trigger: s.trigger, step_count: s.stepCount, merge: s.merge, merge_instructions: s.mergeInstructions ?? "" }, scope: "global" });
    if (res.success === false) throw new Error(String(res.error ?? "reflection settings refused"));
    return parseReflectionSettings(res.reflection_settings);
  }

  // --- providers, agents, memory, skills (the onboarding surface) ----------------------------------

  /** list_connect_providers: the catalogue with each provider's connected state and credential fields. */
  async listConnectProviders(): Promise<ConnectProvider[]> {
    const res = await this.request("list_connect_providers", { target: "local" }, 20_000);
    if (res.success === false) throw new Error(String(res.error ?? "could not list providers"));
    return (res.providers as ConnectProvider[] | undefined) ?? [];
  }

  /** connect_provider: the harness checks the credentials against the provider before saving them. */
  async connectProvider(providerId: string, fields: Record<string, string>, authMethodId?: string): Promise<ConnectProvider[]> {
    const res = await this.request("connect_provider", { target: "local", provider_id: providerId, fields, ...(authMethodId ? { auth_method_id: authMethodId } : {}) }, 45_000);
    if (res.success === false) throw new Error(String(res.error ?? "could not connect the provider"));
    return (res.providers as ConnectProvider[] | undefined) ?? [];
  }

  async disconnectProvider(providerId: string): Promise<ConnectProvider[]> {
    const res = await this.request("disconnect_provider", { target: "local", provider_id: providerId }, 20_000);
    if (res.success === false) throw new Error(String(res.error ?? "could not disconnect the provider"));
    return (res.providers as ConnectProvider[] | undefined) ?? [];
  }

  /**
   * create_agent: a memory-enabled agent from one of Letta's personality presets. Never pinned globally
   * by us (that is Letta Code's own TUI notion). Name and description are set afterwards with agent_update.
   */
  async createAgent(opts: { personality: Personality; model?: string; tags?: string[] }): Promise<{ id: string; name: string; model: string | null }> {
    const res = await this.request("create_agent", { personality: opts.personality, ...(opts.model ? { model: opts.model } : {}), ...(opts.tags ? { tags: opts.tags } : {}), pin_global: false }, 60_000);
    if (res.success === false) throw new Error(String(res.error ?? "could not create the agent"));
    return { id: String(res.agent_id), name: String(res.name ?? ""), model: typeof res.model === "string" ? res.model : null };
  }

  async deleteAgent(agentId: string): Promise<void> {
    const res = await this.request("agent_delete", { agent_id: agentId }, 30_000);
    if (res.success === false) throw new Error(String(res.error ?? "could not delete the agent"));
  }

  /** write_memory_file: a file in the agent's memory repo, committed. */
  async writeMemoryFile(agentId: string, path: string, content: string, commitMessage?: string): Promise<void> {
    const res = await this.request("write_memory_file", { agent_id: agentId, path, content, encoding: "utf8", ...(commitMessage ? { commit_message: commitMessage } : {}) }, 30_000);
    if (res.success === false) throw new Error(String(res.error ?? "could not write the memory file"));
  }

  async deleteMemoryFile(agentId: string, path: string, commitMessage?: string): Promise<void> {
    const res = await this.request("delete_memory_file", { agent_id: agentId, path, ...(commitMessage ? { commit_message: commitMessage } : {}) }, 30_000);
    if (res.success === false) throw new Error(String(res.error ?? "could not delete the memory file"));
  }

  /** skill_enable: symlink a folder holding a SKILL.md into the global skills directory (~/.letta/skills). */
  async skillEnable(skillPath: string): Promise<{ name: string; linkPath: string }> {
    const res = await this.request("skill_enable", { skill_path: skillPath }, 15_000);
    if (res.success === false) throw new Error(String(res.error ?? "could not enable the skill"));
    return { name: String(res.name ?? ""), linkPath: String(res.link_path ?? "") };
  }

  async skillDisable(name: string): Promise<void> {
    const res = await this.request("skill_disable", { name }, 15_000);
    if (res.success === false) throw new Error(String(res.error ?? "could not disable the skill"));
  }

  /** list_models: every concrete model preset this harness can run, including selectable effort variants. */
  async listModels(): Promise<ModelEntry[]> {
    const res = await this.request("list_models", {}, 20_000);
    return modelEntriesFromWire(res.entries);
  }

  /** conversation_update: archive / unarchive (and other record fields). The main chat cannot be updated. */
  async updateConversation(conversationId: string, body: Record<string, unknown>): Promise<void> {
    const res = await this.request("conversation_update", { conversation_id: conversationId, body });
    if (res.success === false) throw new Error(String(res.error ?? "conversation update refused"));
  }

  /** Rename a conversation: Letta keeps its name as `summary` (what runtime_start's create set), the field a desk's title is read from. */
  async renameConversation(conversationId: string, name: string): Promise<void> {
    await this.updateConversation(conversationId, { summary: name });
  }

  /**
   * execute_command: a slash command run by the harness for this conversation (/reload, /compact, …),
   * the path Letta Desktop and the channels use. The harness streams slash_command_start / _end for
   * the transcript and answers here with the output; some commands take a while, hence the long wait.
   */
  async executeCommand(rt: Runtime, commandId: string, args?: string): Promise<{ success: boolean; output: string }> {
    const a = args?.trim();
    const res = await this.request("execute_command", { command_id: commandId, runtime: rt, ...(a ? { args: a } : {}) }, 180_000);
    return { success: res.success !== false, output: typeof res.output === "string" ? res.output : "" };
  }

  /**
   * update_model: switch the model for one conversation (the main chat's switch lands on the agent).
   * Resolves to the handle and effort the server applied; throws with the server's message on refusal.
   */
  async updateModel(rt: Runtime, choice: ModelSelection | string): Promise<AppliedModel> {
    // A bare handle is sent as model_handle alone: with a model_id Letta's resolver takes the id path,
    // and an unregistered handle there skips the exact-handle lookup that carries the preset's settings.
    const selection: ModelSelection = typeof choice === "string" ? { id: "", handle: choice } : choice;
    const payload: Record<string, unknown> = { model_handle: selection.handle };
    if (selection.id) payload.model_id = selection.id;
    if (selection.reasoningEffort !== undefined) payload.reasoning_effort = selection.reasoningEffort;
    const res = await this.request("update_model", { runtime: rt, payload }, 60_000);
    if (res.success === false) throw new Error(String(res.error ?? "model update refused"));
    return {
      handle: String(res.model_handle ?? selection.handle),
      reasoningEffort: reasoningEffortFromSettings(res.model_settings) ?? selection.reasoningEffort ?? null,
    };
  }

  async listAgents(): Promise<Array<{ id: string; name?: string; hidden?: boolean }>> {
    const res = await this.request("agent_list", { query: {} });
    return (res.agents as Array<{ id: string; name?: string; hidden?: boolean }>) ?? [];
  }

  /** Newest-first from the server; returned oldest-first for reading. */
  async listMessages(rt: Runtime, limit = 60): Promise<Array<Record<string, unknown>>> {
    const res = await this.request("conversation_messages_list", { conversation_id: rt.conversation_id, agent_id: rt.agent_id, query: { limit, order: "desc" } });
    const messages = (res.messages as Array<Record<string, unknown>>) ?? [];
    return [...messages].reverse();
  }

  async sendUserMessage(rt: Runtime, text: string, images: ImageAttachment[] = [], context?: string): Promise<boolean> {
    const res = await this.request("input", {
      runtime: rt,
      payload: { kind: "create_message", messages: [{ role: "user", content: buildUserContent(text, images, context), client_message_id: `loki-${Date.now()}` }] },
    });
    const ok = res.accepted !== false && res.success !== false;
    if (!ok) console.warn("loki: message not accepted", res);
    return ok;
  }

  /**
   * Answer a can_use_tool control_request. The server insists on a message
   * for denials and drops malformed responses without applying them, so this
   * waits for the ack and reports whether the decision landed.
   */
  async respondApproval(rt: Runtime, requestId: string, behavior: "allow" | "deny"): Promise<boolean> {
    const decision = behavior === "allow" ? { behavior } : { behavior, message: "Denied from the loki canvas." };
    try {
      const res = await this.request("input", { runtime: rt, payload: { kind: "approval_response", request_id: requestId, decision } });
      const ok = res.type === "input_accepted" && res.success !== false && (res as { accepted?: boolean }).accepted !== false;
      if (!ok) console.warn("loki: approval response not accepted", res);
      return ok;
    } catch (err) {
      console.warn("loki: approval response failed", err);
      return false;
    }
  }
}
