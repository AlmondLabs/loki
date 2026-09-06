import { buildUserContent, type ImageAttachment } from "./content";
import { makeTransport, type Transport } from "./transport";
import { inTauri } from "../desk/env";
/**
 * Browser client for Letta's app-server protocol, reached through the mod's
 * /appserver tunnel (the app-server itself refuses browser origins). Requests
 * correlate by request_id; everything else fans out as events.
 * Docs: https://docs.letta.com/platform/app-server/protocol-lifecycle
 */
export interface Runtime {
  agent_id: string;
  conversation_id: string;
}
export type ServerEvent = Record<string, unknown> & { type: string; runtime?: Runtime };
type Listener = (ev: ServerEvent) => void;

export class AppServerSocket {
  private transport: Transport | null = null;
  private pending = new Map<string, { resolve: (v: ServerEvent) => void; reject: (e: Error) => void; timer: number }>();
  private listeners = new Set<Listener>();
  private runtimes = new Map<string, Runtime>();
  private opening: Promise<void> | null = null;
  private closed = false;
  private retryMs = 500;
  readonly url: string;
  onStatus?: (s: "connecting" | "open" | "closed") => void;

  constructor(url: string) {
    this.url = url;
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  connect(): Promise<void> {
    if (this.opening) return this.opening;
    this.onStatus?.("connecting");
    this.opening = new Promise<void>((resolve, reject) => {
      const transport = makeTransport(this.url);
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
          if (inTauri) return; // the Rust link reconnects on its own and will report "open" again
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
      const timer = window.setTimeout(() => {
        this.pending.delete(request_id);
        reject(new Error(`${type} timed out`));
      }, timeoutMs);
      this.pending.set(request_id, { resolve, reject, timer });
      this.transport!.send(JSON.stringify({ type, request_id, ...payload }));
    });
  }

  async runtimeStart(rt: Runtime): Promise<ServerEvent> {
    const key = `${rt.agent_id}/${rt.conversation_id}`;
    this.runtimes.set(key, rt);
    const res = await this.request("runtime_start", {
      agent_id: rt.agent_id,
      conversation_id: rt.conversation_id,
      // No `mode` (see mod/app-server.ts): never override the permission mode Deepak picked in Desktop.
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

  async listAgents(): Promise<Array<{ id: string; name?: string; hidden?: boolean }>> {
    const res = await this.request("agent_list", { query: {} });
    return (res.agents as Array<{ id: string; name?: string; hidden?: boolean }>) ?? [];
  }

  async listConversations(agentId: string, limit = 100): Promise<Array<Record<string, unknown>>> {
    const res = await this.request("conversation_list", { query: { agent_id: agentId, limit } });
    return (res.conversations as Array<Record<string, unknown>>) ?? [];
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
