import type { Context } from "@earendil-works/chord";
import type { Registry } from "@earendil-works/pi-durable";
import { readLocalAgent } from "../mod/agents.ts";
import { formatTranscript } from "../mod/recall-worker.ts";
import { isWriterChat } from "../core/recall/model.ts";
import type { TranscriptRow } from "../core/attention/transcript.ts";
import type { ChatProjection } from "./chats.ts";
import type { StoreManager } from "./kernel/stores.ts";
import { isReflectionChat } from "./memory.ts";
import { modelRef } from "./chat-backend.ts";
import type { JobName, PassSettings, PassState } from "./passes-state.ts";

/**
 * Background passes (plan 018): reflection and Learn are two jobs on one runner, the same process with different
 * objectives. Once a minute the runner looks over the person's chats; a chat that has been quiet for half an hour,
 * and holds new material past a job's cursor, gets a run of that job (reflection also runs on a chat whose context
 * was just compacted, without the wait). Runs go one at a time across all agents, each as the agent itself in that
 * job's hidden chat for the agent, cleared first. A job brings only its instructions, its tools, what it asks, and
 * what it does with the answer. Each run is one `pass_finished` event; its turn is a `turn_finished` like any other.
 */

/** How long a chat must be quiet before a job reads it. */
export const QUIET_MS = 30 * 60_000;
/** How often the runner looks for chats to read. */
export const SWEEP_MS = 60_000;
/** New transcript text shorter than this is not worth a model call: a thanks, an acknowledgement. The cursor moves on. */
export const MIN_NEW_CHARS = 300;
/** The most of a stretch a run reads: its newest part, so one long chat cannot overflow the pass. */
export const MAX_MATERIAL_CHARS = 24_000;

export type PassInput = { agentId: string; chatId: string; agentName: string | null; rows: TranscriptRow[]; material: string; now: Date };
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
};

export type RunOutcome = "changed" | "nothing" | "capped" | "failed" | "skipped";

export class PassRunner {
  private readonly deps: Deps;
  private readonly queue: Array<{ job: PassJob; agentId: string; chatId: string; force: boolean }> = [];
  private readonly queued = new Set<string>();
  /** A run that failed waits a quiet spell before it is tried again, so a broken model is not asked every minute. */
  private readonly failedAt = new Map<string, number>();
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
    this.timer = setInterval(() => void this.sweep().catch((e: unknown) => this.deps.report?.(`background passes: ${String(e)}`)), this.deps.sweepMs ?? SWEEP_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One look over every chat: queue each run that is due, then work the queue. */
  async sweep(): Promise<void> {
    const settings = this.deps.state.settings();
    const now = this.now();
    for (const row of this.deps.chats.list()) {
      if (row.hidden || isReflectionChat(row.conversationId) || isWriterChat(row.conversationId) || this.deps.isSubagent(row.agentId)) continue;
      for (const job of this.deps.jobs) {
        if (!settings[job.name].enabled) continue;
        if (job.open && !job.open(settings, now)) continue;
        if (await this.due(job, row.agentId, row.conversationId, row.lastMessageAt, now)) this.enqueue(job, row.agentId, row.conversationId, false);
      }
    }
    await this.drain();
  }

  private async due(job: PassJob, agentId: string, chatId: string, lastMessageAt: string | null, now: Date): Promise<boolean> {
    const k = `${job.name}\u0000${agentId}\u0000${chatId}`;
    const quietMs = this.deps.quietMs ?? QUIET_MS;
    const failed = this.failedAt.get(k);
    if (failed !== undefined && now.getTime() - failed < quietMs) return false;
    const cursor = this.deps.state.cursor(job.name, agentId, chatId) ?? 0;
    if (this.deps.chats.answers(chatId, agentId, 0).entries <= cursor) return false;
    const quiet = lastMessageAt !== null && now.getTime() - Date.parse(lastMessageAt) >= quietMs;
    const compacted = job.onCompaction === true && this.deps.chats.compactedSince(chatId, agentId, cursor);
    if (!quiet && !compacted) return false;
    return !(await this.deps.busy(agentId, chatId));
  }

  private enqueue(job: PassJob, agentId: string, chatId: string, force: boolean): void {
    const k = `${job.name}\u0000${agentId}\u0000${chatId}`;
    if (this.queued.has(k)) return;
    this.queued.add(k);
    this.queue.push({ job, agentId, chatId, force });
  }

  /** Work the queue, one run at a time; a second caller waits on the same pass through it. */
  private drain(): Promise<void> {
    this.draining ??= (async () => {
      while (this.queue.length) {
        const next = this.queue.shift()!;
        this.queued.delete(`${next.job.name}\u0000${next.agentId}\u0000${next.chatId}`);
        await this.run(next.job, next.agentId, next.chatId, next.force);
      }
    })().finally(() => (this.draining = null));
    return this.draining;
  }

  /**
   * Run a job on a chat now (`/reflect`, Learn's "Run now"): whether the job is on or not, and without the quiet
   * wait, but never while the chat is busy.
   */
  async runNow(name: JobName, agentId: string, chatId: string): Promise<RunOutcome> {
    const job = this.job(name);
    if (await this.deps.busy(agentId, chatId)) return "skipped";
    return this.run(job, agentId, chatId, true);
  }

  /** "Run now" over every chat a job has new material in: Learn's button, which names no chat. */
  async runAllNow(name: JobName): Promise<void> {
    const job = this.job(name);
    for (const row of this.deps.chats.list()) {
      if (row.hidden || isReflectionChat(row.conversationId) || isWriterChat(row.conversationId) || this.deps.isSubagent(row.agentId)) continue;
      const cursor = this.deps.state.cursor(job.name, row.agentId, row.conversationId) ?? 0;
      if (this.deps.chats.answers(row.conversationId, row.agentId, 0).entries <= cursor) continue;
      if (await this.deps.busy(row.agentId, row.conversationId)) continue;
      this.enqueue(job, row.agentId, row.conversationId, true);
    }
    await this.drain();
  }

  private async run(job: PassJob, agentId: string, chatId: string, force: boolean): Promise<RunOutcome> {
    const started = this.now();
    const k = `${job.name}\u0000${agentId}\u0000${chatId}`;
    const { state, context } = this.deps;
    const cursor = state.cursor(job.name, agentId, chatId) ?? 0;
    const { rows, lines } = this.deps.chats.since(chatId, agentId, cursor);
    const record = readLocalAgent(agentId, this.deps.backendDir);
    const agentName = record?.name ?? null;
    const transcript = formatTranscript(rows, agentName);
    const finish = (outcome: RunOutcome, extra: Record<string, unknown> = {}) => {
      this.deps.capture?.("pass_finished", { job: job.name, agent: agentId, chat: chatId, entries_read: lines - cursor, outcome, duration_ms: this.now().getTime() - started.getTime(), ...extra });
      return outcome;
    };
    if (lines <= cursor) return "nothing";
    if (!transcript.length || (!force && transcript.length < MIN_NEW_CHARS)) {
      state.setCursor(job.name, agentId, chatId, lines);
      return "nothing";
    }
    const input: PassInput = { agentId, chatId, agentName, rows, material: transcript.length > MAX_MATERIAL_CHARS ? transcript.slice(-MAX_MATERIAL_CHARS) : transcript, now: started };
    const requestId = `pass:${job.name}:${chatId}:${lines}`;
    try {
      const prompt = await job.prompt(input);
      if (prompt === null) {
        state.setCursor(job.name, agentId, chatId, lines);
        return finish("nothing", { request_id: null, items: {} });
      }
      const store = await this.deps.stores.get(agentId);
      const model = modelRef(record?.model ?? "");
      const tools = new Set(job.tools(this.deps.registry).map((t) => t.name));
      const agent = { tools: this.deps.registry.snapshot().tools().filter((t) => tools.has(t.tool.name)).map((t) => t.tool), instructions: job.instructions, ...(model ? { model } : {}) };
      const id = job.chatId(agentId);
      let chat = await store.chat(id, context);
      if (!chat) chat = await store.createChat(id, { title: job.title, hidden: true, agent }, context);
      else {
        await chat.configure(agent, context);
        await chat.reset(undefined, context);
      }
      const before = (await store.entries(chat, context)).length;
      const settled = await (await chat.submit({ type: "input", content: prompt, requestId }, context)).wait(context);
      if (settled.status !== "done") throw new Error(`the pass did not finish: ${settled.status}`);
      const answer: PassAnswer = { text: "", toolCalls: [] };
      for (const entry of (await store.entries(chat, context)).slice(before)) {
        const m = entry.model?.[0] as { role?: string; content?: Array<{ type?: string; text?: string; name?: string }> } | undefined;
        if (entry.kind !== "pi.assistant" || m?.role !== "assistant") continue;
        for (const part of m.content ?? []) if (part.type === "toolCall" && part.name) answer.toolCalls.push(part.name);
        const text = (m.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join("").trim();
        if (text) answer.text = text;
      }
      const result = await job.apply(input, answer);
      if (!result.capped) state.setCursor(job.name, agentId, chatId, lines);
      this.failedAt.delete(k);
      const wrote = Object.values(result.items).reduce((n, v) => n + v, 0);
      return finish(result.capped ? "capped" : wrote ? "changed" : "nothing", { request_id: requestId, items: result.items });
    } catch (error) {
      this.failedAt.set(k, this.now().getTime());
      this.deps.report?.(`${job.name} on ${chatId} failed: ${String(error)}`);
      return finish("failed", { request_id: requestId, items: {} });
    }
  }
}
