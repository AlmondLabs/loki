import type { Context } from "@earendil-works/chord";
import type { Conversation } from "@earendil-works/pi-durable";
import type * as acp from "@agentclientprotocol/sdk";
import type { ChatEvent } from "../../core/attention/model.ts";
import { messageSteps } from "../../core/attention/pi-steps.ts";
import type { ChatEngineView } from "../../core/models.ts";
import type { AgentStore, ChatEngine, UsageAdd } from "../kernel/index.ts";

export interface Call {
  name: string;
  args: unknown;
  toolKind?: string;
  textBefore: string;
  thoughtBefore: string;
  output: string;
  done: boolean;
  failed?: boolean;
}

export interface Turn {
  id: string;
  abort: AbortController;
  text: string;
  thought: string;
  at: string | null;
  calls: Map<string, Call>;
  plan: acp.PlanEntry[] | null;
  model: string | null;
  cost: number;
  writes: Array<Promise<void>>;
  startedAt: number;
  firstOutputAt: number | null;
  responses: number;
}

export interface Live {
  agentId: string;
  conversationId: string;
  agent: string;
  model: string;
  effort: string | null;
  sessionId: string | null;
  epoch: symbol | null;
  loading: boolean;
  preamble: string | null;
  turn: Turn | null;
  stop: AbortController | null;
  queue: Promise<void>;
  sent: Set<string>;
  modes: acp.SessionModeState | null;
  configOptions: acp.SessionConfigOption[];
  commands: acp.AvailableCommand[];
  costSoFar: number;
  pass: { instructions: string; tools: readonly string[] } | null;
}

export interface TurnOutcome {
  text: string;
  error: string | null;
}

export interface StreamHost {
  context: Context;
  now: () => string;
  push: (agentId: string, conversationId: string, events: ChatEvent[]) => void;
  view: (engine: Pick<ChatEngine, "agent" | "model">) => ChatEngineView;
  chat: (agentId: string, conversationId: string) => Promise<{ store: AgentStore; chat: Conversation }>;
  saveMode: (agentId: string, conversationId: string, modeId: string) => Promise<void>;
  remember: (live: Live) => void;
}

export const kindOf = (call: Call): { tool_kind?: string } => (call.toolKind ? { tool_kind: call.toolKind } : {});

export const hasArgs = (args: unknown): boolean => args !== undefined && args !== null && !(typeof args === "object" && Object.keys(args).length === 0);

export function contentOutput(content: acp.ToolCallContent[] | null | undefined): string {
  return (content ?? [])
    .map((c) => {
      if (c.type === "diff") {
        const lines = (text: string) => text.replace(/\n$/, "").split("\n");
        const old = lines(c.oldText ?? "").map((l) => `-${l}`);
        const now = lines(c.newText).map((l) => `+${l}`);
        return [`--- ${c.path}`, `+++ ${c.path}`, ...(c.oldText ? old : []), ...now].join("\n");
      }
      if (c.type === "terminal") return `(terminal ${c.terminalId})`;
      return c.content.type === "text" ? c.content.text : `[${c.content.type}]`;
    })
    .join("\n");
}

export function rawText(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  return typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
}

export function planText(entries: acp.PlanEntry[]): string {
  return entries.map((e) => `${e.status === "completed" ? "[x]" : e.status === "in_progress" ? "[~]" : "[ ]"} ${e.content}`).join("\n");
}

export class Stopped extends Error {}

export function unlessStopped<T>(work: Promise<T>, signal: AbortSignal, waitMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopped = () => {
      timer = setTimeout(() => reject(new Stopped("the agent did not stop when asked")), waitMs);
    };
    if (signal.aborted) stopped();
    else signal.addEventListener("abort", stopped, { once: true });
    work.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stopped);
    });
  });
}

export function stopNote(reason: acp.StopReason): string | null {
  if (reason === "refusal") return "the agent refused to continue";
  if (reason === "max_tokens") return "the agent's answer hit its length limit";
  if (reason === "max_turn_requests") return "the agent stopped after its most steps in one turn";
  return null;
}

export async function writeCall(
  host: StreamHost,
  live: Live,
  store: AgentStore,
  chat: Conversation,
  id: string,
  call: Call,
  failed: boolean,
  output: string,
): Promise<void> {
  const at = Date.parse(host.now());
  const content = [
    ...(call.thoughtBefore ? [{ type: "thinking", thinking: call.thoughtBefore }] : []),
    ...(call.textBefore ? [{ type: "text", text: call.textBefore }] : []),
    { type: "toolCall", id, name: call.name, arguments: call.args ?? {}, ...kindOf(call) },
  ];
  const result = [{ type: "text", text: output }];
  host.push(live.agentId, live.conversationId, [
    { kind: "step", step: { kind: "call", name: call.name, args: call.args, id, at: new Date(at).toISOString(), ...kindOf(call) } },
    { kind: "step", step: { kind: "result", id, output: result, failed } },
  ]);
  await store.appendEntries(
    chat,
    [
      { kind: "pi.assistant", message: { role: "assistant", content, timestamp: at } },
      { kind: "pi.tool-result", message: { role: "toolResult", toolCallId: id, toolName: call.name, content: result, isError: failed, timestamp: at } },
    ],
    null,
    host.context,
  );
}

export function completeCall(host: StreamHost, live: Live, turn: Turn, id: string, call: Call, failed: boolean, raw: string): void {
  call.done = true;
  call.failed = failed;
  turn.responses++;
  const output = call.output || raw || (failed ? "the tool failed" : "done");
  turn.writes.push(host.chat(live.agentId, live.conversationId).then(({ store, chat }) => writeCall(host, live, store, chat, id, call, failed, output)));
}

export async function finishTurn(
  host: StreamHost,
  live: Live,
  store: AgentStore,
  chat: Conversation,
  turn: Turn,
  usage: acp.Usage | null,
  engine: ChatEngine,
): Promise<string> {
  await Promise.allSettled(turn.writes);
  await [...turn.calls.entries()]
    .filter(([, call]) => !call.done)
    .reduce<Promise<void>>(
      (chain, [id, call]) =>
        chain.then(() => {
          call.done = true;
          call.failed = true;
          turn.responses++;
          return writeCall(host, live, store, chat, id, call, true, call.output || "the tool did not finish");
        }),
      Promise.resolve(),
    );
  const at = host.now();
  const entries: Array<{ kind: "pi.assistant" | "pi.tool-result"; message: Record<string, unknown> }> = [];
  if (turn.plan) {
    const id = `plan-${turn.id}`;
    turn.responses++;
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
  const thought = turn.thought;
  turn.text = "";
  turn.thought = "";
  if (words) {
    turn.responses++;
    const content = [...(thought ? [{ type: "thinking", thinking: thought }] : []), { type: "text", text: words }];
    const message = { role: "assistant", content, timestamp: Date.parse(turn.at ?? at) };
    entries.push({ kind: "pi.assistant", message });
    host.push(
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
    await store.appendEntries(chat, entries, add ? { model: `acp:${engine.agent}/${turn.model ?? engine.model}`, add } : null, host.context);
  return words;
}

export function applySessionNotification(host: StreamHost, live: Live, n: acp.SessionNotification): void {
  const u = n.update;
  const push = (events: ChatEvent[]) => host.push(live.agentId, live.conversationId, events);
  switch (u.sessionUpdate) {
    case "current_mode_update":
      if (live.modes) live.modes = { ...live.modes, currentModeId: u.currentModeId };
      void host.saveMode(live.agentId, live.conversationId, u.currentModeId).catch(() => {});
      push([{ kind: "device", mode: u.currentModeId }]);
      return;
    case "available_commands_update":
      live.commands = u.availableCommands;
      host.remember(live);
      push([{ kind: "device", engine: host.view({ agent: live.agent, model: live.model }) }]);
      return;
    case "config_option_update":
      live.configOptions = u.configOptions;
      host.remember(live);
      return;
  }
  // Outside (ACP): loading a session replays its history as updates, and loki has it already.
  if (live.loading) return;
  const turn = live.turn;
  if (!turn) return;
  const now = host.now();
  switch (u.sessionUpdate) {
    case "agent_message_chunk":
      if (u.content.type !== "text" || !u.content.text) return;
      turn.at ??= now;
      turn.firstOutputAt ??= Date.parse(now);
      turn.text += u.content.text;
      push([{ kind: "step", step: { kind: "assistant", text: u.content.text, at: now, chunk: true } }]);
      return;
    case "agent_thought_chunk":
      if (u.content.type !== "text" || !u.content.text) return;
      turn.firstOutputAt ??= Date.parse(now);
      turn.thought += u.content.text;
      push([{ kind: "step", step: { kind: "thinking", text: u.content.text, at: now, chunk: true } }]);
      return;
    case "tool_call": {
      turn.firstOutputAt ??= Date.parse(now);
      const call: Call = {
        name: u.title || u.name || u.kind || "tool",
        args: u.rawInput ?? {},
        ...(u.kind ? { toolKind: u.kind } : {}),
        textBefore: turn.text,
        thoughtBefore: turn.thought,
        output: contentOutput(u.content),
        done: false,
      };
      if (turn.text) push([{ kind: "step", step: { kind: "assistant", text: turn.text, at: turn.at ?? now } }]);
      turn.text = "";
      turn.thought = "";
      turn.at = null;
      turn.calls.set(u.toolCallId, call);
      if (hasArgs(call.args)) {
        push([{ kind: "step", step: { kind: "call", name: call.name, args: call.args, id: u.toolCallId, at: now, ...kindOf(call) } }]);
      }
      if (u.status === "completed" || u.status === "failed") completeCall(host, live, turn, u.toolCallId, call, u.status === "failed", rawText(u.rawOutput));
      return;
    }
    case "tool_call_update": {
      const call = turn.calls.get(u.toolCallId);
      if (!call || call.done) return;
      if (u.title) call.name = u.title;
      if (u.kind) call.toolKind = u.kind;
      if (u.rawInput !== undefined) call.args = u.rawInput;
      const output = contentOutput(u.content);
      if (output) call.output = output;
      if (u.status === "completed" || u.status === "failed") completeCall(host, live, turn, u.toolCallId, call, u.status === "failed", rawText(u.rawOutput));
      else if ((u.title || u.rawInput !== undefined) && hasArgs(call.args)) {
        push([{ kind: "step", step: { kind: "call", name: call.name, args: call.args, id: u.toolCallId, at: now, ...kindOf(call) } }]);
      }
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
        // Outside (ACP): an agent reports its session's running total; a total below the last one is a restarted agent's, all of it new.
        turn.cost += u.cost.amount >= live.costSoFar ? u.cost.amount - live.costSoFar : u.cost.amount;
        live.costSoFar = u.cost.amount;
      }
      return;
    }
    default:
      return;
  }
}
