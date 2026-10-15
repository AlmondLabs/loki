import type { Context } from "@earendil-works/chord";
import { withCancel } from "@earendil-works/chord/context";
import type { Registry } from "@earendil-works/pi-durable";
import { readLocalAgent } from "../mod/agents.ts";
import { formatTranscript } from "../mod/recall-worker.ts";
import { isWriterChat } from "../core/recall/model.ts";
import type { TranscriptRow } from "../core/attention/transcript.ts";
import type { ChatProjection } from "./chats.ts";
import type { StoreManager } from "./kernel/stores.ts";
import { isDoctorChat, isReflectionChat, memoryDump, memoryRoot, MEMORY_TOOLS } from "./memory.ts";
import { DOCTOR_INSTRUCTIONS, DOCTOR_TOOLS, doctorChatId, doctorPrompt } from "./doctor.ts";
import { modelRef } from "./chat-backend.ts";
import { createHash } from "node:crypto";
import type { JobName, PassSettings, PassState } from "./passes-state.ts";

/**
 * Background passes (plan 018): reflection and Learn are two jobs on one runner, the same process with different
 * objectives. Once a minute the runner looks over the person's chats; a chat that has been quiet for half an hour,
 * and holds new material past a job's cursor, is due for that job (reflection also takes a chat whose context was
 * just compacted, without the wait). A run takes every due chat of one agent at once, each chat's new stretch as its
 * own labelled part, so a job sees what recurs or conflicts across conversations rather than one at a time. An agent
 * gets at most one batch per BATCH_EVERY_MS for a job, so more chats gather into each, unless a chat was compacted or
 * the last batch left chats for later. Runs go one at a time across all agents, each as the agent itself in that
 * job's hidden chat for the agent, cleared first. Cursors stay per chat and move only when the run succeeds. A job
 * brings only its instructions, its tools, what it asks, and what it does with the answer. Each run is one
 * `pass_finished` event; its turn is a `turn_finished` like any other. The memory review (/doctor, daemon/doctor.ts)
 * reads memory rather than chats, but goes through the same queue and the same hidden-chat run.
 */

/** A memory review's result: how it ended, what it changed, and its report for the person. */
export type DoctorResult = { outcome: RunOutcome; changes: number; report: string };

/** How long a chat must be quiet before a job reads it. */
export const QUIET_MS = 30 * 60_000;
/** How often the runner looks for chats to read. */
export const SWEEP_MS = 60_000;
/** New transcript text shorter than this is not worth a model call: a thanks, an acknowledgement. The cursor moves on. */
export const MIN_NEW_CHARS = 300;
/** The most of one chat's stretch a run reads: its oldest part, up to an entry's end; the rest is the next run's. */
export const MAX_MATERIAL_CHARS = 24_000;
/** The most a batch reads across its chats; a chat whose stretch does not fit whole waits for the next batch. */
export const MAX_BATCH_CHARS = 80_000;
/** An agent's batches for a job are at least this far apart, so chats gather into each (not after a compaction). */
export const BATCH_EVERY_MS = 2 * 60 * 60_000;
/** The longest a run may take before its pass chat is stopped and the run counted as failed. */
export const RUN_TIMEOUT_MS = 10 * 60_000;

/** One chat's new stretch in a run: its transcript from the job's cursor up to `lines`. */
export type PassPart = { chatId: string; title: string | null; rows: TranscriptRow[]; material: string; from: number; lines: number };
/** A run's material: one agent's due chats, each a part, and all of them as one labelled text (batchText). */
export type PassInput = { agentId: string; agentName: string | null; parts: PassPart[]; material: string; now: Date };

/** The parts as one text: each chat in its own tag, named and numbered, so the job can tell them apart and cite them. */
export function batchText(parts: readonly PassPart[]): string {
  return parts.map((p, i) => `<conversation n="${i + 1}"${p.title ? ` title=${JSON.stringify(p.title)}` : ""}>\n${p.material}\n</conversation>`).join("\n\n");
}
export type PassAnswer = { text: string; toolCalls: string[] };
/** What a run did: `items` counts what it wrote by kind; `capped` keeps the cursor for another day. */
export type PassResult = { items: Record<string, number>; capped?: boolean };

export interface PassJob {
  name: JobName;
  /** The job's hidden chat for an agent; its prefix is how the rest of loki knows it (memory.ts, telemetry, the mod). */
  chatId(agentId: string): string;
  title: string;
  instructions: string;
  tools(registry: Registry): ReadonlyArray<{ name: string }>;
  /** Reflection reads a just-compacted chat without waiting for it to go quiet. */
  onCompaction?: boolean;
  /** Whether the job can run today at all (Learn: room left under the day's cap). */
  open?(settings: PassSettings, now: Date): boolean;
  /** What to ask, or null when the material holds nothing this job wants (the cursor moves on). */
  prompt(input: PassInput): Promise<string | null> | string | null;
  apply(input: PassInput, answer: PassAnswer): Promise<PassResult> | PassResult;
}

type Deps = {
  stores: StoreManager;
  chats: ChatProjection;
  registry: Registry;
  state: PassState;
  backendDir: string;
  context: Context;
  jobs: readonly PassJob[];
  /** Whether a chat has a turn running (its LiveDoc, daemon/chat-backend.ts). */
  busy(agentId: string, chatId: string): Promise<boolean>;
  isSubagent(agentId: string): boolean;
  capture?(event: string, properties: Record<string, unknown>): void;
  report?(message: string): void;
  now?(): Date;
  quietMs?: number;
  sweepMs?: number;
  runTimeoutMs?: number;
  batchEveryMs?: number;
};

export type RunOutcome = "changed" | "nothing" | "capped" | "failed" | "skipped";

export class PassRunner {
  private readonly deps: Deps;
  /** Runs waiting their turn, each under the keys it holds while queued or running (a job's chats, a review's agent). */
  private readonly queue: Array<{ keys: string[]; work: () => Promise<void> }> = [];
  /** Queued or running, by job and chat: a sweep during a run does not queue it again. */
  private readonly queued = new Set<string>();
  /** A run that failed waits a quiet spell before it is tried again, so a broken model is not asked every minute. */
  private readonly failedAt = new Map<string, number>();
  /** When each agent's last batch for a job started, and which left chats for later (those go without the wait). */
  private readonly lastBatch = new Map<string, number>();
  private readonly backlog = new Set<string>();
  private draining: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: Deps) {
    this.deps = deps;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private job(name: JobName): PassJob {
    const job = this.deps.jobs.find((j) => j.name === name);
    if (!job) throw new Error(`no background pass named ${name}`);
    return job;
  }

  start(): void {
    this.stop();
    this.timer = setInterval(
      () => void this.sweep().catch((e: unknown) => this.deps.report?.(`background passes: ${String(e)}`)),
      this.deps.sweepMs ?? SWEEP_MS,
    );
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The person's chats: not hidden (a pass's own chats among them), not a helper's. */
  private chats() {
    return this.deps.chats
      .list()
      .filter(
        (row) =>
          !row.hidden &&
          !isReflectionChat(row.conversationId) &&
          !isDoctorChat(row.conversationId) &&
          !isWriterChat(row.conversationId) &&
          !this.deps.isSubagent(row.agentId),
      );
  }

  /** One look over every chat: queue a batch for each agent with chats due, then work the queue. */
  async sweep(): Promise<void> {
    const settings = this.deps.state.settings();
    const now = this.now();
    // Oldest first: the chat that has waited longest is read first, and is first in its batch.
    const rows = this.chats().sort((a, b) => (a.lastMessageAt ?? "").localeCompare(b.lastMessageAt ?? ""));
    for (const job of this.deps.jobs) {
      if (!settings[job.name].enabled) continue;
      if (job.open && !job.open(settings, now)) continue;
      const due = new Map<string, { chats: string[]; urgent: boolean }>();
      for (const row of rows) {
        const why = await this.due(job, row.agentId, row.conversationId, row.lastMessageAt, now);
        if (!why) continue;
        const d = due.get(row.agentId) ?? { chats: [], urgent: false };
        d.chats.push(row.conversationId);
        d.urgent ||= why === "compacted";
        due.set(row.agentId, d);
      }
      for (const [agentId, d] of due) {
        const k = `${job.name}\u0000${agentId}`;
        const last = this.lastBatch.get(k);
        const waited = last === undefined || now.getTime() - last >= (this.deps.batchEveryMs ?? BATCH_EVERY_MS) || this.backlog.has(k);
        if (d.urgent || waited) void this.enqueue(job, agentId, d.chats, false);
      }
    }
    await this.drain();
  }

  private async due(job: PassJob, agentId: string, chatId: string, lastMessageAt: string | null, now: Date): Promise<"quiet" | "compacted" | null> {
    const k = `${job.name}\u0000${agentId}\u0000${chatId}`;
    const quietMs = this.deps.quietMs ?? QUIET_MS;
    const failed = this.failedAt.get(k);
    if (failed !== undefined && now.getTime() - failed < quietMs) return null;
    const cursor = this.deps.state.cursor(job.name, agentId, chatId) ?? 0;
    if (this.deps.chats.answers(chatId, agentId, 0).entries <= cursor) return null;
    const quiet = lastMessageAt !== null && now.getTime() - Date.parse(lastMessageAt) >= quietMs;
    const compacted = job.onCompaction === true && this.deps.chats.compactedSince(chatId, agentId, cursor);
    if (!quiet && !compacted) return null;
    if (await this.deps.busy(agentId, chatId)) return null;
    return compacted ? "compacted" : "quiet";
  }

  /**
   * Queue a batch; resolves with its outcome, or "skipped" when every chat in it is already queued or running: a chat
   * is in one batch at a time, and a batch takes only the chats not already in another.
   */
  private enqueue(job: PassJob, agentId: string, chatIds: string[], force: boolean): Promise<RunOutcome> {
    const fresh = chatIds.filter((c) => !this.queued.has(`${job.name}\u0000${agentId}\u0000${c}`));
    if (!fresh.length) return Promise.resolve("skipped");
    return this.schedule(
      fresh.map((c) => `${job.name}\u0000${agentId}\u0000${c}`),
      () => this.run(job, agentId, fresh, force),
    );
  }

  /** Put a run in the queue under its keys; it resolves with the run's own result once its turn has come and gone. */
  private schedule<T>(keys: string[], work: () => Promise<T>): Promise<T> {
    for (const k of keys) this.queued.add(k);
    return new Promise<T>((resolve, reject) => this.queue.push({ keys, work: () => work().then(resolve, reject) }));
  }

  /** Work the queue, one run at a time; a second caller waits on the same pass through it. */
  private drain(): Promise<void> {
    this.draining ??= (async () => {
      await Promise.resolve(); // `draining` is set before the loop can end and clear it
      try {
        while (this.queue.length) {
          const next = this.queue.shift()!;
          try {
            await next.work();
          } finally {
            for (const k of next.keys) this.queued.delete(k);
          }
        }
      } finally {
        // Cleared in the same step the loop ends, so a run queued after it starts a new pass rather than waiting.
        this.draining = null;
      }
    })();
    return this.draining;
  }

  /**
   * Run a job on a chat now (`/reflect`, Learn's "Run now"): whether the job is on or not, and without the quiet
   * wait, but never while the chat is busy, and in the same queue as every other run.
   */
  async runNow(name: JobName, agentId: string, chatId: string): Promise<RunOutcome> {
    const outcome = this.enqueue(this.job(name), agentId, [chatId], true);
    await this.drain();
    return outcome;
  }

  /**
   * "Run now" over every chat a job has new material in: Learn's button, which names no chat. Each agent's chats go
   * in batches, round after round until none has anything new left (a busy chat is left for the sweep).
   */
  async runAllNow(name: JobName): Promise<void> {
    const job = this.job(name);
    for (let round = 0; round < 20; round++) {
      const byAgent = new Map<string, string[]>();
      for (const row of this.chats()) {
        const cursor = this.deps.state.cursor(job.name, row.agentId, row.conversationId) ?? 0;
        if (this.deps.chats.answers(row.conversationId, row.agentId, 0).entries <= cursor) continue;
        if (await this.deps.busy(row.agentId, row.conversationId)) continue;
        byAgent.set(row.agentId, [...(byAgent.get(row.agentId) ?? []), row.conversationId]);
      }
      if (!byAgent.size) return;
      const outcomes = [...byAgent].map(([agentId, chats]) => this.enqueue(job, agentId, chats, true));
      await this.drain();
      if ((await Promise.all(outcomes)).every((o) => o === "failed" || o === "skipped" || o === "capped")) return;
    }
  }

  /** What a batch reads: each chat's stretch in order, within MAX_BATCH_CHARS; a busy chat, or one that does not fit, waits. */
  private async gather(job: PassJob, agentId: string, chatIds: string[], agentName: string | null, force: boolean) {
    const { state } = this.deps;
    const parts: PassPart[] = [];
    let room = MAX_BATCH_CHARS;
    let busy = false;
    let leftover = false;
    for (const chatId of chatIds) {
      // The chat may have woken while the run waited its turn: it waits for the next sweep, its cursor where it was.
      if (await this.deps.busy(agentId, chatId)) {
        busy = true;
        continue;
      }
      const cursor = state.cursor(job.name, agentId, chatId) ?? 0;
      const stretch = this.stretch(chatId, agentId, cursor, agentName);
      if (stretch.lines <= cursor) continue;
      if (!stretch.transcript.length || (!force && stretch.transcript.length < MIN_NEW_CHARS)) {
        state.setCursor(job.name, agentId, chatId, stretch.lines);
        continue;
      }
      // Whole or not at all: a stretch cut to fit what is left of the batch would move its cursor past unread text.
      if (stretch.transcript.length > room && parts.length) {
        leftover = true;
        continue;
      }
      if (stretch.lines < this.deps.chats.answers(chatId, agentId, 0).entries) leftover = true; // more than one run reads
      room -= stretch.transcript.length;
      parts.push({
        chatId,
        title: this.deps.chats.info(chatId, agentId)?.title ?? null,
        rows: stretch.rows,
        material: stretch.transcript,
        from: cursor,
        lines: stretch.lines,
      });
    }
    return { parts, busy, leftover };
  }

  private async run(job: PassJob, agentId: string, chatIds: string[], force: boolean): Promise<RunOutcome> {
    const started = this.now();
    const agentKey = `${job.name}\u0000${agentId}`;
    const keyOf = (chatId: string) => `${agentKey}\u0000${chatId}`;
    const { state } = this.deps;
    let parts: PassPart[] = [];
    let requestId: string | null = null;
    const finish = (outcome: RunOutcome, extra: Record<string, unknown> = {}) => {
      const read = parts.reduce((n, p) => n + p.lines - p.from, 0);
      this.deps.capture?.("pass_finished", {
        job: job.name,
        agent: agentId,
        chat: parts[0]?.chatId ?? chatIds[0],
        chats: parts.map((p) => p.chatId),
        entries_read: read,
        outcome,
        duration_ms: this.now().getTime() - started.getTime(),
        request_id: requestId,
        items: {},
        ...extra,
      });
      return outcome;
    };
    try {
      const record = readLocalAgent(agentId, this.deps.backendDir);
      const agentName = record?.name ?? null;
      const gathered = await this.gather(job, agentId, chatIds, agentName, force);
      parts = gathered.parts;
      if (!parts.length) return gathered.busy ? "skipped" : finish("nothing");
      const input: PassInput = { agentId, agentName, parts, material: batchText(parts), now: started };
      const advance = () => {
        for (const p of parts) state.setCursor(job.name, agentId, p.chatId, p.lines);
      };
      const prompt = await job.prompt(input);
      if (prompt === null) {
        advance();
        return finish("nothing");
      }
      // The pass chat is reset, not recreated, and pi-durable answers a repeated request id with the old submission:
      // each attempt gets its own id, so a retry (or Learn's capped stretch the next day) is really asked again.
      const which = createHash("sha256")
        .update(parts.map((p) => `${p.chatId}@${p.lines}`).join("\n"))
        .digest("hex")
        .slice(0, 12);
      requestId = `pass:${job.name}:${agentId}:${which}:${started.getTime().toString(36)}`;
      const answer = await this.ask(agentId, record?.model ?? "", {
        chatId: job.chatId(agentId),
        title: job.title,
        instructions: job.instructions,
        tools: job.tools(this.deps.registry).map((t) => t.name),
        prompt,
        requestId,
      });
      const result = await job.apply(input, answer);
      if (!result.capped) advance();
      for (const p of parts) this.failedAt.delete(keyOf(p.chatId));
      this.lastBatch.set(agentKey, started.getTime());
      if (gathered.leftover) this.backlog.add(agentKey);
      else this.backlog.delete(agentKey);
      const wrote = Object.values(result.items).reduce((n, v) => n + v, 0);
      return finish(result.capped ? "capped" : wrote ? "changed" : "nothing", { items: result.items });
    } catch (error) {
      // Each chat waits a quiet spell before it is tried again (due); not the batch gap too, or a failure costs hours.
      for (const c of parts.length ? parts.map((p) => p.chatId) : chatIds) this.failedAt.set(keyOf(c), this.now().getTime());
      this.deps.report?.(`${job.name} on ${(parts.length ? parts.map((p) => p.chatId) : chatIds).join(", ")} failed: ${String(error)}`);
      return finish("failed");
    }
  }

  /**
   * Ask the agent something in a pass's hidden chat, cleared first and set up with the pass's instructions and tools,
   * and read back what it said and which tools it called. A run past the time limit is stopped and fails.
   */
  private async ask(
    agentId: string,
    agentModel: string,
    spec: { chatId: string; title: string; instructions: string; tools: readonly string[]; prompt: string; requestId: string },
  ): Promise<PassAnswer> {
    const { context } = this.deps;
    const store = await this.deps.stores.get(agentId);
    const model = modelRef(agentModel);
    const tools = new Set(spec.tools);
    const agent = {
      tools: this.deps.registry
        .snapshot()
        .tools()
        .filter((t) => tools.has(t.tool.name))
        .map((t) => t.tool),
      instructions: spec.instructions,
      ...(model ? { model } : {}),
    };
    let chat = await store.chat(spec.chatId, context);
    if (!chat) chat = await store.createChat(spec.chatId, { title: spec.title, hidden: true, agent }, context);
    else {
      await chat.configure(agent, context);
      await chat.reset(undefined, context);
    }
    const before = (await store.entries(chat, context)).length;
    const submission = await chat.submit({ type: "input", content: spec.prompt, requestId: spec.requestId }, context);
    // One hung run must not hold every other pass behind it: past the limit the pass chat is stopped and the run fails.
    const limited = withCancel(context);
    const timer = setTimeout(() => limited.cancel(new Error("timed out")), this.deps.runTimeoutMs ?? RUN_TIMEOUT_MS);
    let settled: Awaited<ReturnType<typeof submission.wait>>;
    try {
      settled = await submission.wait(limited.context);
    } catch (error) {
      if (!limited.context.abortSignal?.aborted) throw error;
      await chat.abort(context).catch(() => {});
      throw new Error(`the pass did not finish within ${Math.round((this.deps.runTimeoutMs ?? RUN_TIMEOUT_MS) / 1000)}s`);
    } finally {
      clearTimeout(timer);
    }
    if (settled.status !== "done") throw new Error(`the pass did not finish: ${settled.status}`);
    const answer: PassAnswer = { text: "", toolCalls: [] };
    for (const entry of (await store.entries(chat, context)).slice(before)) {
      const m = entry.model?.[0] as { role?: string; content?: Array<{ type?: string; text?: string; name?: string }> } | undefined;
      if (entry.kind !== "pi.assistant" || m?.role !== "assistant") continue;
      for (const part of m.content ?? []) if (part.type === "toolCall" && part.name) answer.toolCalls.push(part.name);
      const text = (m.content ?? [])
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("")
        .trim();
      if (text) answer.text = text;
    }
    return answer;
  }

  /**
   * The memory review (/doctor): the agent reads all of its memory and cleans it up (daemon/doctor.ts), in the same
   * queue as every pass. A second review of the same agent while one is queued or running is not started.
   */
  async runDoctor(agentId: string): Promise<DoctorResult> {
    const key = `doctor\u0000${agentId}`;
    if (this.queued.has(key)) return { outcome: "skipped", changes: 0, report: "a memory review of this agent is already running" };
    const result = this.schedule([key], () => this.doctor(agentId));
    await this.drain();
    return result;
  }

  private async doctor(agentId: string): Promise<DoctorResult> {
    const started = this.now();
    const requestId = `pass:doctor:${agentId}:${started.getTime().toString(36)}`;
    const finish = (result: DoctorResult, extra: Record<string, unknown> = {}) => {
      this.deps.capture?.("pass_finished", {
        job: "doctor",
        agent: agentId,
        outcome: result.outcome,
        duration_ms: this.now().getTime() - started.getTime(),
        request_id: requestId,
        items: { memory_changes: result.changes },
        ...extra,
      });
      return result;
    };
    try {
      const record = readLocalAgent(agentId, this.deps.backendDir);
      const dump = memoryDump(memoryRoot(this.deps.backendDir, agentId));
      if (!dump.files) return finish({ outcome: "nothing", changes: 0, report: "this agent has no memory to review yet" });
      const answer = await this.ask(agentId, record?.model ?? "", {
        chatId: doctorChatId(agentId),
        title: "doctor",
        instructions: DOCTOR_INSTRUCTIONS,
        tools: DOCTOR_TOOLS,
        prompt: doctorPrompt(dump, started),
        requestId,
      });
      const changes = answer.toolCalls.filter((t) => t !== "memory_read" && MEMORY_TOOLS.includes(t)).length;
      const report = answer.text || (changes ? `${changes} change${changes === 1 ? "" : "s"} to memory` : "memory looks healthy");
      return finish({ outcome: changes ? "changed" : "nothing", changes, report }, { files: dump.files, chars: dump.chars });
    } catch (error) {
      this.deps.report?.(`memory review of ${agentId} failed: ${String(error)}`);
      return finish({ outcome: "failed", changes: 0, report: `the memory review did not finish: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  /**
   * The stretch a run reads: from the cursor, as many whole entries as fit in MAX_MATERIAL_CHARS, the oldest first,
   * so a long stretch is read over several runs and none of it is skipped. A single entry longer than that is read
   * from its start.
   */
  private stretch(chatId: string, agentId: string, from: number, agentName: string | null): { rows: TranscriptRow[]; lines: number; transcript: string } {
    const read = (to?: number) => {
      const { rows, lines } = this.deps.chats.since(chatId, agentId, from, to);
      return { rows, lines, transcript: formatTranscript(rows, agentName) };
    };
    const all = read();
    if (all.transcript.length <= MAX_MATERIAL_CHARS) return all;
    // The furthest end whose stretch still fits; the length only grows with the end.
    let lo = from + 1;
    let hi = all.lines;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (read(mid).transcript.length <= MAX_MATERIAL_CHARS) lo = mid;
      else hi = mid - 1;
    }
    const fit = read(lo);
    return { ...fit, transcript: fit.transcript.slice(0, MAX_MATERIAL_CHARS) };
  }
}
