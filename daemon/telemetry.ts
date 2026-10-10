import type { Context } from "@earendil-works/chord";
import type { CommitPublication, ConversationId, EntryRecord } from "@earendil-works/pi-durable";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { scopeFor } from "../core/desk-core.ts";
import { contentText, isScheduledPrompt } from "../core/harness.ts";
import { isWriterChat } from "../core/recall/model.ts";
import { appVersion } from "../mod/analytics.ts";
import type { AgentStore } from "./kernel/index.ts";
import type { StoreManager } from "./kernel/stores.ts";
import { turnTimings, type Span } from "./timing.ts";

/**
 * One `turn_finished` event per agent turn (core/analytics.ts), so a change to the harness can be measured: the
 * daemon follows every store's commits, and when a chat's run ends it reads what the run saved (each response's
 * usage, cost and time, each tool's result and time; daemon/timing.ts) and captures one line into events.jsonl. The
 * clock is the daemon's: a turn starts when pi-durable starts its run, its first output is the first commit carrying
 * the answer in flight, and it ends when the run ends. Ids, counts and fixed words only, never what was said.
 */

/** Where a turn came from: you, a scheduled prompt, a background task's notice, a helper, Learn's writer, reflection. */
export type TurnOrigin = "message" | "schedule" | "background" | "subagent" | "recall" | "reflection";

/** The turn's id: its agent and the submission that opened its run. The app gets the same id on the chat's events. */
export function turnIdOf(agentId: string, inputs: readonly unknown[]): string | null {
  return inputs.length ? `${agentId}:${String(inputs[0])}` : null;
}

/** The harness this daemon runs: a checkout's commit (marked when its tracked files have changes), else loki's version. */
export function harnessVersion(root: string): string | null {
  if (existsSync(join(root, ".git"))) {
    try {
      return execFileSync("git", ["describe", "--always", "--dirty", "--exclude=*"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
    } catch {
      // no git on PATH: the version below
    }
  }
  return appVersion(root);
}

/** A short code, or "other": pi-durable's reasons and statuses are words, but nothing free-form reaches the file. */
const code = (word: unknown): string => (typeof word === "string" && /^[a-z][a-z_]{0,31}$/.test(word) ? word : "other");

type Message = {
  role?: string;
  content?: unknown;
  timestamp?: number;
  durationMs?: number;
  provider?: string;
  model?: string;
  stopReason?: string;
  isError?: boolean;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number; cost?: { total?: number } };
};

export type FinishedTurn = {
  agentId: string;
  /** loki's chat id, and what loki keeps about the chat. */
  chatId: string;
  hidden: boolean;
  title: string | null;
  turnId: string | null;
  /** The first input's request id (a helper's starts `subagent:`). */
  requestId: string | null;
  /** The entries the run wrote, the person's message among them. */
  entries: ReadonlyArray<Pick<EntryRecord, "kind" | "model">>;
  startedAt: number;
  firstOutputAt: number | null;
  endedAt: number;
  /** An input's reason for going unanswered, else the run task's outcome when it was not `completed`. */
  failure: string | null;
  agentIsSubagent: boolean;
  harnessVersion: string | null;
  /** The chat's model, for a turn that wrote no response. */
  model: string | null;
};

export function originOf(t: Pick<FinishedTurn, "chatId" | "hidden" | "title" | "requestId" | "entries" | "agentIsSubagent">): TurnOrigin {
  if (t.agentIsSubagent || t.requestId?.startsWith("subagent:")) return "subagent";
  // A background pass's run (daemon/passes.ts) says which job it is in its request id.
  if (t.requestId?.startsWith("pass:learn:")) return "recall";
  if (t.requestId?.startsWith("pass:reflection:")) return "reflection";
  if (isWriterChat(t.chatId) || (t.hidden && t.title === "recall")) return "recall";
  if (t.chatId.startsWith("reflection-")) return "reflection";
  const first = t.entries.find((e) => e.kind === "pi.user")?.model?.[0] as Message | undefined;
  const text = first ? contentText(first.content as never).trimStart() : "";
  if (isScheduledPrompt(text)) return "schedule";
  if (text.startsWith("<task-notification>")) return "background";
  return "message";
}

const round = (n: number) => Math.round(n);

/** The event's properties for one finished turn. */
export function turnProperties(t: FinishedTurn): Record<string, unknown> {
  const messages = t.entries.flatMap((e) => (e.model ?? []) as Message[]);
  const answers = messages.filter((m) => m.role === "assistant");
  const results = messages.filter((m) => m.role === "toolResult");
  const models: Span[] = answers.filter((m) => typeof m.timestamp === "number").map((m) => ({ start: m.timestamp!, end: m.timestamp! + (m.durationMs ?? 0) }));
  const tools: Span[] = results.filter((m) => typeof m.timestamp === "number").map((m) => ({ start: m.timestamp! - (m.durationMs ?? 0), end: m.timestamp! }));
  const timings = turnTimings({ sentAt: t.startedAt, firstOutputAt: t.firstOutputAt, models, tools, endAt: t.endedAt });
  const sum = (pick: (u: NonNullable<Message["usage"]>) => number | undefined) => answers.reduce((n, m) => n + (m.usage ? pick(m.usage) ?? 0 : 0), 0);
  const input = sum((u) => u.input), cacheRead = sum((u) => u.cacheRead), cacheWrite = sum((u) => u.cacheWrite);
  const prompt = input + cacheRead + cacheWrite;
  const last = answers.at(-1);
  const stopReason = last?.stopReason ?? null;
  const errorCode = t.failure ? code(t.failure) : stopReason === "error" || stopReason === "aborted" ? stopReason : null;
  return {
    desk: scopeFor(t.chatId, t.agentId),
    chat: t.chatId,
    agent: t.agentId,
    model: last?.provider && last.model ? `${last.provider}/${last.model}` : t.model,
    harness_version: t.harnessVersion,
    turn_id: t.turnId,
    origin: originOf(t),
    // A background pass's request id, which its pass_finished line carries too.
    ...(t.requestId?.startsWith("pass:") ? { request_id: t.requestId } : {}),
    input_tokens: input,
    output_tokens: sum((u) => u.output),
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    reasoning_tokens: sum((u) => u.reasoning),
    cache_share: prompt ? Math.round((cacheRead / prompt) * 1000) / 1000 : null,
    cost: Math.round(sum((u) => u.cost?.total) * 1e6) / 1e6,
    responses: answers.length,
    ttft_ms: timings.ttftMs === null ? null : round(timings.ttftMs),
    total_ms: round(timings.totalMs),
    model_ms: round(timings.modelMs),
    tool_ms: round(timings.toolMs),
    overhead_ms: round(timings.overheadMs),
    tool_calls: results.length,
    tool_failures: results.filter((m) => m.isError === true).length,
    stop_reason: stopReason === null ? null : code(stopReason),
    error: errorCode !== null,
    error_code: errorCode,
  };
}

/** A run in flight; `taskId` is the task running it now. */
type Running = { taskId: unknown; inputs: unknown[]; startedAt: number; firstOutputAt: number | null; entries: EntryRecord[] };

type Deps = {
  capture: (event: string, properties: Record<string, unknown>) => void;
  harnessVersion: string | null;
  isSubagent: (agentId: string) => boolean;
  context: Context;
  report?: (message: string) => void;
  now?: () => number;
};

/** Follows every store's commits and captures `turn_finished` as each run ends. */
export class TurnTelemetry {
  private readonly deps: Deps;
  private readonly now: () => number;
  private readonly unsubscribe = new Map<string, () => void>();
  /** In-flight runs, by agent and pi-durable conversation. */
  private readonly running = new Map<string, Running>();
  /** Submissions' request ids, kept while their run runs. */
  private readonly requests = new Map<string, string>();

  constructor(deps: Deps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  follow(stores: StoreManager): () => void {
    return stores.onOpen((agentId, store) => this.attach(agentId, store));
  }

  attach(agentId: string, store: AgentStore): void {
    this.unsubscribe.get(agentId)?.();
    for (const key of [...this.running.keys()]) if (key.startsWith(`${agentId}\u0000`)) this.running.delete(key);
    this.unsubscribe.set(agentId, store.harness.subscribeCommits((publication) => this.apply(agentId, store, publication)));
  }

  private apply(agentId: string, store: AgentStore, publication: CommitPublication): void {
    const at = this.now();
    const unanswered = new Map<string, { conversationId: number; reason: string }>();
    const outcomes = new Map<string, string>();
    for (const change of publication.changes) {
      if (change.type === "submission") {
        const s = change.value as { id: unknown; conversationId: number; requestId?: string; status: string; reason?: string };
        if (s.requestId) this.requests.set(`${agentId}\u0000${String(s.id)}`, s.requestId);
        if (s.status === "unanswered") unanswered.set(String(s.id), { conversationId: s.conversationId, reason: s.reason ?? "unanswered" });
      } else if (change.type === "task") {
        const outcome = (change.value as { state?: { outcome?: { status?: string } } }).state?.outcome?.status;
        if (outcome && outcome !== "completed") outcomes.set(String(change.value.id), outcome);
      } else if (change.type === "entry") {
        const run = this.running.get(`${agentId}\u0000${change.value.conversationId}`);
        if (!run) continue;
        run.entries.push(change.value);
        if (change.value.kind === "pi.assistant") run.firstOutputAt ??= at;
      }
    }
    const inRuns = new Set<string>();
    for (const change of publication.changes) {
      if (change.type !== "document" || change.record.kind !== "pi.live" || change.conversationId === undefined) continue;
      const key = `${agentId}\u0000${change.conversationId}`;
      const live = (change.value ?? {}) as { run?: { taskId: unknown; inputs: unknown[] }; generation?: { message?: { content?: unknown[] } }; tools?: unknown[] };
      let run = this.running.get(key);
      // A run hands over to a new task after each tool round; it is the same run while its first input is.
      if (run && live.run && String(live.run.inputs[0]) === String(run.inputs[0])) run.taskId = live.run.taskId;
      else if (run) {
        for (const id of run.inputs) inRuns.add(String(id));
        this.running.delete(key);
        const failure = run.inputs.map((id) => unanswered.get(String(id))?.reason).find(Boolean) ?? outcomes.get(String(run.taskId)) ?? null;
        void this.finish(agentId, store, change.conversationId, run, at, failure);
        run = undefined;
      }
      if (live.run && !run) {
        run = { taskId: live.run.taskId, inputs: [...live.run.inputs], startedAt: at, firstOutputAt: null, entries: [] };
        this.running.set(key, run);
        for (const id of run.inputs) inRuns.add(String(id));
        // The run's own entries in this commit (the person's message, placed as the run starts).
        for (const c of publication.changes) if (c.type === "entry" && c.value.conversationId === change.conversationId) run.entries.push(c.value);
      }
      if (run && ((live.generation?.message?.content?.length ?? 0) > 0 || (live.tools?.length ?? 0) > 0)) run.firstOutputAt ??= at;
    }
    // A message the agent could not take up at all (no model, a provider with no sign-in): a turn that ended at once.
    for (const [id, { conversationId, reason }] of unanswered) {
      if (inRuns.has(id) || [...this.running.values()].some((r) => r.inputs.some((i) => String(i) === id))) continue;
      void this.finish(agentId, store, conversationId, { taskId: null, inputs: [id], startedAt: at, firstOutputAt: null, entries: [] }, at, reason);
    }
  }

  private async finish(agentId: string, store: AgentStore, conversationId: number, run: Running, endedAt: number, failure: string | null): Promise<void> {
    try {
      const { context } = this.deps;
      const [info, settings] = await Promise.all([store.chatInfo(conversationId as ConversationId, context), store.agentSettings(conversationId as ConversationId, context)]);
      if (!info?.id) return; // not a chat of loki's
      const model = (settings as { model?: { provider?: string; modelId?: string } } | undefined)?.model;
      const requestKey = `${agentId}\u0000${String(run.inputs[0])}`;
      const requestId = this.requests.get(requestKey) ?? null;
      for (const id of run.inputs) this.requests.delete(`${agentId}\u0000${String(id)}`);
      this.deps.capture(
        "turn_finished",
        turnProperties({
          agentId,
          chatId: info.id,
          hidden: info.hidden,
          title: info.title,
          turnId: turnIdOf(agentId, run.inputs),
          requestId,
          entries: run.entries,
          startedAt: run.startedAt,
          firstOutputAt: run.firstOutputAt,
          endedAt,
          failure,
          agentIsSubagent: this.deps.isSubagent(agentId),
          harnessVersion: this.deps.harnessVersion,
          model: model?.provider && model.modelId ? `${model.provider}/${model.modelId}` : null,
        }),
      );
    } catch (error) {
      this.deps.report?.(`turn telemetry: ${String(error)}`);
    }
  }
}
