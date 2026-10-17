import type { Context } from "@earendil-works/chord";
import type { Conversation } from "@earendil-works/pi-durable";
import type * as acp from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { contentText } from "../../core/harness.ts";
import type { ChatEvent } from "../../core/attention/model.ts";
import { messageSteps } from "../../core/attention/pi-steps.ts";
import type { ChatState, PayloadOf } from "../../core/frames.ts";
import type { Approvals } from "../approvals.ts";
import type { AgentStore, ChatEngine, ChatInfo, UsageAdd } from "../kernel/index.ts";
import type { StoreManager } from "../kernel/stores.ts";
import type { AcpAgentConfig } from "./agents.ts";
import { AcpProcess } from "./process.ts";

/**
 * Chats that run on an ACP agent (plan 020). Each chat has a session on its agent's process; a message is a
 * `session/prompt`, and what the agent reports as it works (`session/update`) becomes loki's chat events for every
 * client and, as each message completes, entries in the chat's own store. So the thread, the Inbox, history and the
 * passes read an ACP chat as they read any other (R7), and the usage the agent reports lands in the usage ledger
 * (R9). The agent's permission requests are loki's approval cards (KD10).
 */

interface Deps {
  stores: StoreManager;
  approvals: Approvals;
  context: Context;
  /** The ACP agents loki knows (daemon/acp/agents.ts), read on each use so an added agent needs no restart. */
  agents: () => AcpAgentConfig[];
  /** What is added to the agent's system prompt for a loki agent: its persona and memory (KD5); null for nothing. */
  systemPrompt?: (agentId: string) => string | null;
  /** The folder a chat with none set runs in. */
  homeDir: string;
  now?: () => Date;
}

/** A tool call in the turn running now: shown as it changes, written when it finishes. */
interface Call {
  name: string;
  args: unknown;
  /** The words the agent wrote before the call, which the stored assistant message carries with it. */
  textBefore: string;
  output: string;
  done: boolean;
}

/** The turn running in a chat. */
interface Turn {
  id: string;
  abort: AbortController;
  /** The words of the answer in flight, since the last tool call. */
  text: string;
  at: string | null;
  calls: Map<string, Call>;
  plan: acp.PlanEntry[] | null;
  /** The model the agent says answered (Claude's adapter names it on its usage updates). */
  model: string | null;
  /** Dollars the agent reported spending in this turn. */
  cost: number;
  /** Finished calls being written, which the turn's end waits for so its last words come after them. */
  writes: Array<Promise<void>>;
}

/** One ACP chat as loki is running it now; made on first use, and forgotten when the daemon stops. */
interface Live {
  agentId: string;
  conversationId: string;
  agent: string;
  sessionId: string | null;
  /** The process start the session belongs to: a restarted agent has none of its sessions open. */
  epoch: number;
  /** The agent replays a loaded session's history as updates; loki has it already, so they are dropped. */
  loading: boolean;
  /** Words for the agent's first prompt of a session, when it takes no system prompt (KD5). */
  preamble: string | null;
  turn: Turn | null;
  queue: Promise<void>;
  sent: Set<string>;
  modes: acp.SessionModeState | null;
  configOptions: acp.SessionConfigOption[];
  commands: acp.AvailableCommand[];
  /** The agent's running total of dollars for the session (it reports the total, not each turn's). */
  costSoFar: number;
}

const key = (agentId: string, conversationId: string) => `${agentId}\u0000${conversationId}`;

/** A tool call's content as text: its words, a diff as a unified diff, a terminal by name. */
function contentOutput(content: acp.ToolCallContent[] | null | undefined): string {
  return (content ?? [])
    .map((c) => {
      if (c.type === "diff") {
        const old = (c.oldText ?? "").split("\n").map((l) => `-${l}`);
        const now = c.newText.split("\n").map((l) => `+${l}`);
        return [`--- ${c.path}`, `+++ ${c.path}`, ...(c.oldText ? old : []), ...now].join("\n");
      }
      if (c.type === "terminal") return `(terminal ${c.terminalId})`;
      return c.content.type === "text" ? c.content.text : `[${c.content.type}]`;
    })
    .join("\n");
}

/** A raw output the agent attached, as text, when its content said nothing. */
function rawText(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  return typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
}

/** The plan as a checklist. */
function planText(entries: acp.PlanEntry[]): string {
  return entries.map((e) => `${e.status === "completed" ? "[x]" : e.status === "in_progress" ? "[~]" : "[ ]"} ${e.content}`).join("\n");
}

/** Why a turn stopped short, for the person; null when it simply ended. */
function stopNote(reason: acp.StopReason): string | null {
  if (reason === "refusal") return "the agent refused to continue";
  if (reason === "max_tokens") return "the agent's answer hit its length limit";
  if (reason === "max_turn_requests") return "the agent stopped after its most steps in one turn";
  return null;
}

/** The chats on ACP agents, as DaemonChats routes them here (daemon/chat-backend.ts). */
export class AcpChats {
  private push: (agentId: string, conversationId: string, events: ChatEvent[]) => void = () => {};
  private readonly live = new Map<string, Live>();
  private readonly bySession = new Map<string, Live>();
  private readonly processes = new Map<string, AcpProcess>();
  private readonly deps: Deps;

  constructor(deps: Deps) {
    this.deps = deps;
  }

  attach(push: (agentId: string, conversationId: string, events: ChatEvent[]) => void): void {
    this.push = push;
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  /** The agent named `id`, if loki knows it. */
  agent(id: string): AcpAgentConfig | undefined {
    return this.deps.agents().find((a) => a.id === id);
  }

  /** The agent's process, made on first use (it starts when first asked for something). */
  private process(agent: string): AcpProcess {
    let proc = this.processes.get(agent);
    if (!proc) {
      const config = this.agent(agent);
      if (!config) throw new Error(`no ACP agent named ${agent}; add it in Settings`);
      proc = new AcpProcess(config, {
        update: (n) => this.update(n),
        permission: (r) => this.permission(r),
      });
      this.processes.set(agent, proc);
    }
    return proc;
  }

  private liveOf(agentId: string, conversationId: string, engine: ChatEngine): Live {
    let live = this.live.get(key(agentId, conversationId));
    if (!live) {
      live = {
        agentId,
        conversationId,
        agent: engine.agent,
        sessionId: null,
        epoch: -1,
        loading: false,
        preamble: null,
        turn: null,
        queue: Promise.resolve(),
        sent: new Set(),
        modes: null,
        configOptions: [],
        commands: [],
        costSoFar: 0,
      };
      this.live.set(key(agentId, conversationId), live);
    }
    return live;
  }

  private async chat(agentId: string, conversationId: string): Promise<{ store: AgentStore; chat: Conversation; info: Readonly<ChatInfo> }> {
    const store = await this.deps.stores.get(agentId);
    const chat = await store.chat(conversationId, this.deps.context);
    const info = chat ? await store.chatInfo(chat.id, this.deps.context) : undefined;
    if (!chat || !info) throw new Error(`no chat ${conversationId} for ${agentId}`);
    return { store, chat, info };
  }

  /** Whether a turn is running in the chat or waits on the person. */
  busy(agentId: string, conversationId: string): boolean {
    return Boolean(this.live.get(key(agentId, conversationId))?.turn) || this.deps.approvals.waitingIn(agentId, conversationId).length > 0;
  }

  /** The chat as a client opening it sees it: running or not, the answer in flight, its mode and folder. */
  async state(agentId: string, conversationId: string): Promise<ChatState> {
    const { store, chat, info } = await this.chat(agentId, conversationId);
    const live = this.live.get(key(agentId, conversationId));
    const settings = (await store.agentSettings(chat.id, this.deps.context)) as { cwd?: string } | undefined;
    const waiting = this.deps.approvals.waitingIn(agentId, conversationId).length > 0;
    const turn = live?.turn ?? null;
    return {
      agent_id: agentId,
      conversation_id: conversationId,
      loop: waiting ? "approval" : turn ? "running" : "idle",
      turn_id: turn?.id ?? null,
      mode: info.mode ?? live?.modes?.currentModeId ?? null,
      cwd: settings?.cwd ?? null,
      ...(turn?.text ? { streaming: { text: turn.text, at: turn.at } } : {}),
    };
  }

  /** The person's message: it waits for the turn before it, then runs as its own (a message sent twice runs once). */
  send(p: PayloadOf<"chat_send">, engine: ChatEngine): void {
    const live = this.liveOf(p.agent_id, p.conversation_id, engine);
    if (p.send_id) {
      if (live.sent.has(p.send_id)) return;
      live.sent.add(p.send_id);
    }
    const text = [p.context, p.text.trim() ? p.text : null].filter((t): t is string => Boolean(t)).join("\n\n");
    this.enqueue(live, text, p.images);
  }

  /** A message from loki itself (a schedule's prompt, a background task's notice): queued like the person's. */
  deliver(agentId: string, conversationId: string, text: string, engine: ChatEngine): void {
    this.enqueue(this.liveOf(agentId, conversationId, engine), text, []);
  }

  private enqueue(live: Live, text: string, images: PayloadOf<"chat_send">["images"]): void {
    live.queue = live.queue.then(() => this.run(live, text, images)).catch(() => {});
  }

  /** Stop the turn running now: what waits on the person is withdrawn, and the agent is asked to cancel. */
  async abort(agentId: string, conversationId: string): Promise<void> {
    const live = this.live.get(key(agentId, conversationId));
    if (!live?.turn) return;
    live.turn.abort.abort();
    if (live.sessionId) await this.process(live.agent).cancel(live.sessionId);
  }

  /** The agent's mode for the chat (KD10): remembered on the chat, and set on its session when one is open. */
  async setMode(agentId: string, conversationId: string, modeId: string): Promise<void> {
    const { store } = await this.chat(agentId, conversationId);
    await store.updateChat(conversationId, { mode: modeId }, this.deps.context);
    const live = this.live.get(key(agentId, conversationId));
    if (live?.sessionId && live.epoch === this.process(live.agent).epoch()) await this.applyMode(live, modeId);
    this.push(agentId, conversationId, [{ kind: "device", mode: modeId }]);
  }

  /** The agent's model for the chat: set on its session when one is open; a new session starts on it. */
  async setModel(agentId: string, conversationId: string, model: string): Promise<void> {
    const live = this.live.get(key(agentId, conversationId));
    if (live?.sessionId && live.epoch === this.process(live.agent).epoch()) await this.applyModel(live, model);
  }

  /** The slash commands the agent offers in this chat, as it last listed them. */
  commands(agentId: string, conversationId: string): acp.AvailableCommand[] {
    return this.live.get(key(agentId, conversationId))?.commands ?? [];
  }

  /** Stop every agent process; the daemon is stopping. */
  async close(): Promise<void> {
    await Promise.all([...this.processes.values()].map((p) => p.close()));
  }

  private async applyMode(live: Live, modeId: string): Promise<void> {
    if (!live.sessionId) return;
    const proc = this.process(live.agent);
    if (live.modes?.availableModes.some((m) => m.id === modeId)) {
      if (live.modes.currentModeId === modeId) return;
      await proc.setMode(live.sessionId, modeId);
      live.modes = { ...live.modes, currentModeId: modeId };
      return;
    }
    const option = live.configOptions.find((o) => o.category === "mode" && o.type === "select");
    if (option?.type === "select" && option.currentValue !== modeId)
      live.configOptions = (await proc.setConfigOption(live.sessionId, option.id, modeId)).configOptions;
  }

  private async applyModel(live: Live, model: string): Promise<void> {
    if (!live.sessionId || model === "default") return;
    const option = live.configOptions.find((o) => o.category === "model" && o.type === "select");
    if (option?.type === "select" && option.currentValue !== model) {
      live.configOptions = (await this.process(live.agent).setConfigOption(live.sessionId, option.id, model)).configOptions;
    }
  }

  /**
   * The chat's session on its agent, opened if it has none on the running process: the one it had, loaded, when the
   * agent can load sessions (R8); otherwise a new one, and the chat says the agent starts afresh.
   */
  private async session(live: Live, store: AgentStore, chat: Conversation, info: Readonly<ChatInfo>, engine: ChatEngine): Promise<string> {
    const proc = this.process(live.agent);
    const caps = await proc.capabilities();
    if (live.sessionId && live.epoch === proc.epoch()) return live.sessionId;
    const settings = (await store.agentSettings(chat.id, this.deps.context)) as { cwd?: string } | undefined;
    const cwd = settings?.cwd ?? this.deps.homeDir;
    const prompt = this.deps.systemPrompt?.(live.agentId) ?? null;
    const takesPrompt = Boolean(caps.sessionCapabilities?.systemPrompt);
    const systemPrompt = prompt && takesPrompt ? { systemPrompt: { mode: "append" as const, content: [{ type: "text" as const, text: prompt }] } } : {};
    if (live.sessionId) this.bySession.delete(live.sessionId);
    let opened: { sessionId: string; modes?: acp.SessionModeState | null; configOptions?: acp.SessionConfigOption[] | null } | null = null;
    if (engine.session_id && caps.loadSession) {
      live.sessionId = engine.session_id;
      this.bySession.set(engine.session_id, live);
      live.loading = true;
      try {
        opened = { sessionId: engine.session_id, ...(await proc.loadSession({ sessionId: engine.session_id, cwd, mcpServers: [], ...systemPrompt })) };
      } catch {
        // The agent no longer has it (its own history was cleared, say): a new session, said so below.
        opened = null;
      } finally {
        live.loading = false;
      }
    }
    if (!opened) {
      if (engine.session_id) {
        const note = "the agent could not pick up where this chat left off, so it starts afresh; it does not remember the messages above";
        this.push(live.agentId, live.conversationId, [{ kind: "error", message: note }]);
      }
      opened = await proc.newSession({ cwd, mcpServers: [], ...systemPrompt });
      await store.updateChat(live.conversationId, { engine: { ...engine, session_id: opened.sessionId } }, this.deps.context);
    }
    live.sessionId = opened.sessionId;
    live.epoch = proc.epoch();
    live.modes = opened.modes ?? null;
    live.configOptions = opened.configOptions ?? [];
    live.preamble = prompt && !takesPrompt ? prompt : null;
    this.bySession.set(opened.sessionId, live);
    await this.applyModel(live, engine.model);
    if (info.mode) await this.applyMode(live, info.mode).catch(() => {});
    return opened.sessionId;
  }

  /** One turn: the message written and shown, sent to the agent, and the chat settled when it answers or fails. */
  private async run(live: Live, text: string, images: PayloadOf<"chat_send">["images"]): Promise<void> {
    const { store, chat, info } = await this.chat(live.agentId, live.conversationId);
    if (info.engine?.kind !== "acp") return;
    const proc = this.process(live.agent);
    const turn: Turn = {
      id: `acp-${randomUUID()}`,
      abort: new AbortController(),
      text: "",
      at: null,
      calls: new Map(),
      plan: null,
      model: null,
      cost: 0,
      writes: [],
    };
    live.turn = turn;
    const at = this.now();
    const content = [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.media_type })),
    ];
    this.push(live.agentId, live.conversationId, [
      { kind: "loop", state: "running", turn_id: turn.id },
      { kind: "step", step: { kind: "user", raw: contentText(content), at } },
    ]);
    await store.appendEntries(chat, [{ kind: "pi.user", message: { role: "user", content, timestamp: Date.parse(at) } }], null, this.deps.context);
    try {
      const sessionId = await this.session(live, store, chat, info, info.engine);
      const caps = await proc.capabilities();
      const prompt: acp.ContentBlock[] = [
        ...(live.preamble ? [{ type: "text" as const, text: `<loki-agent>\n${live.preamble}\n</loki-agent>` }] : []),
        ...(text ? [{ type: "text" as const, text }] : []),
        ...(caps.promptCapabilities?.image ? images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.media_type })) : []),
      ];
      live.preamble = null;
      if (images.length && !caps.promptCapabilities?.image)
        this.push(live.agentId, live.conversationId, [{ kind: "error", message: "this agent takes no pictures; they were not sent" }]);
      const response = await proc.prompt({ sessionId, prompt });
      await this.finish(live, store, chat, turn, response.usage ?? null, info.engine);
      const note = stopNote(response.stopReason);
      if (note) this.push(live.agentId, live.conversationId, [{ kind: "error", message: note }]);
    } catch (error) {
      await this.finish(live, store, chat, turn, null, info.engine).catch(() => {});
      this.push(live.agentId, live.conversationId, [{ kind: "error", message: proc.failure(error).message }]);
    } finally {
      live.turn = null;
      this.push(live.agentId, live.conversationId, [{ kind: "settle" }, { kind: "loop", state: "idle" }, { kind: "turn_end", turn_id: turn.id }]);
    }
  }

  /** The end of a turn: calls left open fail, the plan and the last words are written, and the usage counted. */
  private async finish(live: Live, store: AgentStore, chat: Conversation, turn: Turn, usage: acp.Usage | null, engine: ChatEngine): Promise<void> {
    await Promise.allSettled(turn.writes);
    for (const [id, call] of turn.calls) {
      if (call.done) continue;
      call.done = true;
      await this.writeCall(live, store, chat, id, call, true, call.output || "the tool did not finish");
    }
    const at = this.now();
    const entries: Array<{ kind: "pi.assistant" | "pi.tool-result"; message: Record<string, unknown> }> = [];
    if (turn.plan) {
      const id = `plan-${turn.id}`;
      entries.push(
        { kind: "pi.assistant", message: { role: "assistant", content: [{ type: "toolCall", id, name: "plan", arguments: {} }], timestamp: Date.parse(at) } },
        {
          kind: "pi.tool-result",
          message: {
            role: "toolResult",
            toolCallId: id,
            toolName: "plan",
            content: [{ type: "text", text: planText(turn.plan) }],
            isError: false,
            timestamp: Date.parse(at),
          },
        },
      );
    }
    const words = turn.text;
    turn.text = "";
    if (words) {
      const message = { role: "assistant", content: [{ type: "text", text: words }], timestamp: Date.parse(turn.at ?? at) };
      entries.push({ kind: "pi.assistant", message });
      this.push(
        live.agentId,
        live.conversationId,
        messageSteps(message, turn.at ?? at).map((step) => ({ kind: "step", step })),
      );
    }
    const add: UsageAdd | null =
      usage || turn.cost
        ? {
            input: usage?.inputTokens ?? 0,
            output: usage?.outputTokens ?? 0,
            cacheRead: usage?.cachedReadTokens ?? 0,
            cacheWrite: usage?.cachedWriteTokens ?? 0,
            cost: turn.cost,
          }
        : null;
    if (entries.length || add)
      await store.appendEntries(chat, entries, add ? { model: `acp:${engine.agent}/${turn.model ?? engine.model}`, add } : null, this.deps.context);
  }

  /** A tool call that finished (or never will): its call and its result written, and the result shown. */
  private async writeCall(live: Live, store: AgentStore, chat: Conversation, id: string, call: Call, failed: boolean, output: string): Promise<void> {
    const at = Date.parse(this.now());
    const content = [
      ...(call.textBefore ? [{ type: "text", text: call.textBefore }] : []),
      { type: "toolCall", id, name: call.name, arguments: call.args ?? {} },
    ];
    const result = [{ type: "text", text: output }];
    this.push(live.agentId, live.conversationId, [
      { kind: "step", step: { kind: "call", name: call.name, args: call.args, id, at: new Date(at).toISOString() } },
      { kind: "step", step: { kind: "result", id, output: result, failed } },
    ]);
    await store.appendEntries(
      chat,
      [
        { kind: "pi.assistant", message: { role: "assistant", content, timestamp: at } },
        { kind: "pi.tool-result", message: { role: "toolResult", toolCallId: id, toolName: call.name, content: result, isError: failed, timestamp: at } },
      ],
      null,
      this.deps.context,
    );
  }

  /** What the agent reports as it works, for whichever chat the session is. */
  private update(n: acp.SessionNotification): void {
    const live = this.bySession.get(n.sessionId);
    if (!live || live.loading) return;
    const u = n.update;
    const push = (events: ChatEvent[]) => this.push(live.agentId, live.conversationId, events);
    switch (u.sessionUpdate) {
      case "current_mode_update":
        if (live.modes) live.modes = { ...live.modes, currentModeId: u.currentModeId };
        void this.deps.stores
          .get(live.agentId)
          .then((store) => store.updateChat(live.conversationId, { mode: u.currentModeId }, this.deps.context))
          .catch(() => {});
        push([{ kind: "device", mode: u.currentModeId }]);
        return;
      case "available_commands_update":
        live.commands = u.availableCommands;
        return;
      case "config_option_update":
        live.configOptions = u.configOptions;
        return;
    }
    const turn = live.turn;
    if (!turn) return;
    const now = this.now();
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content.type !== "text" || !u.content.text) return;
        turn.at ??= now;
        turn.text += u.content.text;
        push([{ kind: "step", step: { kind: "assistant", text: u.content.text, at: now, chunk: true } }]);
        return;
      case "tool_call": {
        // The words so far belong before the call: they settle as written, and go into the call's stored message.
        const call: Call = {
          name: u.title || u.name || u.kind || "tool",
          args: u.rawInput ?? {},
          textBefore: turn.text,
          output: contentOutput(u.content),
          done: false,
        };
        if (turn.text) push([{ kind: "step", step: { kind: "assistant", text: turn.text, at: turn.at ?? now } }]);
        turn.text = "";
        turn.at = null;
        turn.calls.set(u.toolCallId, call);
        push([{ kind: "step", step: { kind: "call", name: call.name, args: call.args, id: u.toolCallId, at: now } }]);
        if (u.status === "completed" || u.status === "failed") this.completeCall(live, turn, u.toolCallId, call, u.status === "failed", rawText(u.rawOutput));
        return;
      }
      case "tool_call_update": {
        const call = turn.calls.get(u.toolCallId);
        if (!call || call.done) return;
        if (u.title) call.name = u.title;
        if (u.rawInput !== undefined) call.args = u.rawInput;
        const output = contentOutput(u.content);
        if (output) call.output = output;
        if (u.status === "completed" || u.status === "failed") this.completeCall(live, turn, u.toolCallId, call, u.status === "failed", rawText(u.rawOutput));
        else if (u.title || u.rawInput !== undefined)
          push([{ kind: "step", step: { kind: "call", name: call.name, args: call.args, id: u.toolCallId, at: now } }]);
        return;
      }
      case "plan":
        turn.plan = u.entries;
        push([
          { kind: "step", step: { kind: "call", name: "plan", args: {}, id: `plan-${turn.id}`, at: now } },
          { kind: "step", step: { kind: "result", id: `plan-${turn.id}`, output: [{ type: "text", text: planText(u.entries) }], failed: false } },
        ]);
        return;
      case "usage_update": {
        const model = u._meta?.["_claude/model"];
        if (typeof model === "string" && model) turn.model = model;
        if (u.cost?.currency === "USD") {
          // A total below the last one is a new session's (the agent restarted): all of it is new.
          turn.cost += u.cost.amount >= live.costSoFar ? u.cost.amount - live.costSoFar : u.cost.amount;
          live.costSoFar = u.cost.amount;
        }
        return;
      }
      default:
        return;
    }
  }

  /** A call the agent says finished: done now (so the turn's end leaves it be), written in the background. */
  private completeCall(live: Live, turn: Turn, id: string, call: Call, failed: boolean, raw: string): void {
    call.done = true;
    const output = call.output || raw || (failed ? "the tool failed" : "done");
    turn.writes.push(this.chat(live.agentId, live.conversationId).then(({ store, chat }) => this.writeCall(live, store, chat, id, call, failed, output)));
  }

  /**
   * The agent asks before a tool call: a loki approval card with the agent's own choices behind it. Allow picks its
   * "allow once" (or "always allow" when the person ticked always), deny its "reject once"; a stopped turn answers
   * cancelled, as ACP asks.
   */
  private async permission(r: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const live = this.bySession.get(r.sessionId);
    if (!live?.turn) return { outcome: { outcome: "cancelled" } };
    const call = live.turn.calls.get(r.toolCall.toolCallId);
    const event = {
      kind: "approval" as const,
      request_id: `acp-${randomUUID()}`,
      tool_name: r.toolCall.title || call?.name || r.toolCall.name || "tool",
      input: r.toolCall.rawInput ?? call?.args ?? {},
    };
    try {
      const d = await this.deps.approvals.ask<{ allow: boolean; always?: boolean }>(live.agentId, live.conversationId, event, live.turn.abort.signal, {
        remember: false,
      });
      const pick = (...kinds: acp.PermissionOptionKind[]) => kinds.map((k) => r.options.find((o) => o.kind === k)).find((o) => o !== undefined);
      const option = d.allow ? (d.always ? pick("allow_always", "allow_once") : pick("allow_once", "allow_always")) : pick("reject_once", "reject_always");
      return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
    } catch {
      return { outcome: { outcome: "cancelled" } };
    }
  }
}
