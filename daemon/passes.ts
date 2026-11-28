import type { Context } from "@earendil-works/chord/context";
import { withCancel } from "@earendil-works/chord/context";
import type { EntryRecord, Registry } from "@earendil-works/pi-durable";
import { readLocalAgent } from "../mod/agents.ts";
import { formatTranscript } from "../mod/learn-worker.ts";
import { isWriterChat } from "../core/learn/model.ts";
import { daemonTimeReminder } from "../core/attention/content.ts";
import type { TranscriptRow } from "../core/attention/transcript.ts";
import type { ChatProjection } from "./chats.ts";
import { unansweredWhy } from "./chat-events.ts";
import type { StoreManager } from "./kernel/stores.ts";
import { ACP_PASS_SUFFIX, isDoctorChat, isReflectionChat, memoryDump, memoryRoot, MEMORY_TOOLS, overBudget, sharedMemoryRoot } from "./memory.ts";
import type { ChatEngine } from "./kernel/index.ts";
import { DOCTOR_INSTRUCTIONS, DOCTOR_TOOLS, doctorChatId, doctorPrompt } from "./doctor.ts";
import { modelRef } from "./loki-engine.ts";
import { createHash } from "node:crypto";
import type { JobName, PassSettings, PassState } from "./passes-state.ts";
import { messageOf } from "../core/errors.ts";
import { PASS_RUN_TIMEOUT_MS } from "../core/frames.ts";

export interface DoctorResult {
  outcome: RunOutcome;
  changes: number;
  report: string;
}

export const QUIET_MS = 30 * 60_000;
export const SWEEP_MS = 60_000;
export const MIN_NEW_CHARS = 300;
export const MAX_MATERIAL_CHARS = 24_000;
export const MAX_BATCH_CHARS = 80_000;
export const BATCH_EVERY_MS = 2 * 60 * 60_000;

export interface PassPart {
  chatId: string;
  title: string | null;
  rows: TranscriptRow[];
  material: string;
  from: number;
  lines: number;
}
export interface PassInput {
  agentId: string;
  agentName: string | null;
  memoryRoot?: string;
  sharedMemoryRoot?: string;
  signals?: string | null;
  goals?: string | null;
  parts: PassPart[];
  material: string;
  now: Date;
}

export function batchText(parts: readonly PassPart[]): string {
  return parts.map((p, i) => `<conversation n="${i + 1}"${p.title ? ` title=${JSON.stringify(p.title)}` : ""}>\n${p.material}\n</conversation>`).join("\n\n");
}
export interface PassAnswer {
  text: string;
  toolCalls: string[];
}
export interface PassResult {
  items: Record<string, number>;
  capped?: boolean;
}

export interface PassJob {
  name: JobName;
  chatId(agentId: string): string;
  title: string;
  instructions: string;
  tools(registry: Registry): ReadonlyArray<{ name: string }>;
  onCompaction?: boolean;
  failedCalls?: boolean;
  open?(settings: PassSettings, now: Date): boolean;
  prompt(input: PassInput): Promise<string | null> | string | null;
  apply(input: PassInput, answer: PassAnswer): Promise<PassResult> | PassResult;
}

export interface PassSummary {
  job: string;
  agent: string;
  outcome: string;
  items: Record<string, unknown>;
  request_id?: string | null;
  chat?: string;
  chats?: string[];
  entries_read?: number;
  files?: number;
  chars?: number;
  engine?: string;
  duration_ms: number;
}

interface Deps {
  stores: StoreManager;
  chats: ChatProjection;
  registry: Registry;
  state: PassState;
  backendDir: string;
  context: Context;
  jobs: readonly PassJob[];
  busy(agentId: string, chatId: string): Promise<boolean>;
  canRun?(model: string): Promise<boolean>;
  collectSignals?(agentId: string, since: string | null): string | null;
  goalsSummary?(agentId: string): string | null;
  acp?: {
    engineFor(agentId: string): Promise<ChatEngine | null>;
    ask(agentId: string, engine: ChatEngine, spec: PassSpec & { timeoutMs: number }): Promise<PassAnswer>;
  };
  onPass?(summary: PassSummary): void;
  report?(message: string): void;
  now?(): Date;
  quietMs?: number;
  sweepMs?: number;
  runTimeoutMs?: number;
  batchEveryMs?: number;
}

export interface PassSpec {
  chatId: string;
  title: string;
  instructions: string;
  tools: readonly string[];
  prompt: string;
  requestId: string;
}

type PassEngine = { kind: "loki" } | { kind: "acp"; engine: ChatEngine };

export type RunOutcome = "changed" | "nothing" | "capped" | "failed" | "skipped";

export class PassRunner {
  private readonly deps: Deps;
  private readonly queue: Array<{ keys: string[]; place: "last" | "next"; work: () => Promise<void> }> = [];
  private readonly queued = new Set<string>();
  private readonly failedAt = new Map<string, number>();
  private readonly lastBatch = new Map<string, number>();
  private readonly backlog = new Set<string>();
  private draining = false;
  private drained: Promise<void> = Promise.resolve();
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
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private chats() {
    return this.deps.chats
      .list()
      .filter((row) => !row.hidden && !isReflectionChat(row.conversationId) && !isDoctorChat(row.conversationId) && !isWriterChat(row.conversationId));
  }

  async sweep(): Promise<void> {
    const settings = this.deps.state.settings();
    const now = this.now();
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
    if (this.deps.chats.entryCount(chatId, agentId) <= cursor) return null;
    const quiet = lastMessageAt !== null && now.getTime() - Date.parse(lastMessageAt) >= quietMs;
    const compacted = job.onCompaction === true && this.deps.chats.compactedSince(chatId, agentId, cursor);
    if (!quiet && !compacted) return null;
    if (await this.deps.busy(agentId, chatId)) return null;
    return compacted ? "compacted" : "quiet";
  }

  private enqueue(job: PassJob, agentId: string, chatIds: string[], force: boolean): Promise<RunOutcome> {
    const fresh = chatIds.filter((c) => !this.queued.has(`${job.name}\u0000${agentId}\u0000${c}`));
    if (!fresh.length) return Promise.resolve("skipped");
    return this.schedule(
      fresh.map((c) => `${job.name}\u0000${agentId}\u0000${c}`),
      () => this.run(job, agentId, fresh, force),
    );
  }

  private schedule<T>(keys: string[], work: () => Promise<T>, place: "last" | "next" = "last"): Promise<T> {
    for (const k of keys) this.queued.add(k);
    return new Promise<T>((resolve, reject) => {
      const item = { keys, place, work: () => work().then(resolve, reject) };
      const at = place === "next" ? this.queue.findIndex((q) => q.place === "last") : -1;
      if (at === -1) this.queue.push(item);
      else this.queue.splice(at, 0, item);
    });
  }

  private drain(): Promise<void> {
    if (this.draining) return this.drained;
    this.draining = true;
    this.drained = this.runQueue();
    return this.drained;
  }

  private async runQueue(): Promise<void> {
    try {
      for (let next = this.queue.shift(); next; next = this.queue.shift()) {
        try {
          await next.work();
        } finally {
          for (const k of next.keys) this.queued.delete(k);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  async runNow(name: JobName, agentId: string, chatId: string): Promise<RunOutcome> {
    const outcome = this.enqueue(this.job(name), agentId, [chatId], true);
    await this.drain();
    return outcome;
  }

  async runAllNow(name: JobName): Promise<void> {
    const job = this.job(name);
    for (let round = 0; round < 20; round++) {
      const byAgent = new Map<string, string[]>();
      for (const row of this.chats()) {
        const cursor = this.deps.state.cursor(job.name, row.agentId, row.conversationId) ?? 0;
        if (this.deps.chats.entryCount(row.conversationId, row.agentId) <= cursor) continue;
        if (await this.deps.busy(row.agentId, row.conversationId)) continue;
        let list = byAgent.get(row.agentId);
        if (!list) {
          list = [];
          byAgent.set(row.agentId, list);
        }
        list.push(row.conversationId);
      }
      if (!byAgent.size) return;
      const outcomes = [...byAgent].map(([agentId, chats]) => this.enqueue(job, agentId, chats, true));
      await this.drain();
      if ((await Promise.all(outcomes)).every((o) => o === "failed" || o === "skipped" || o === "capped")) return;
    }
  }

  private async gather(job: PassJob, agentId: string, chatIds: string[], agentName: string | null, force: boolean) {
    const { state } = this.deps;
    const parts: PassPart[] = [];
    let room = MAX_BATCH_CHARS;
    let busy = false;
    let leftover = false;
    const cursorUpdates: Array<{ chatId: string; at: number }> = [];
    for (const chatId of chatIds) {
      if (await this.deps.busy(agentId, chatId)) {
        busy = true;
        continue;
      }
      const cursor = state.cursor(job.name, agentId, chatId) ?? 0;
      const stretch = this.stretch(job, chatId, agentId, cursor, agentName);
      if (stretch.lines <= cursor) continue;
      if (!stretch.transcript.length || (!force && stretch.transcript.length < MIN_NEW_CHARS)) {
        cursorUpdates.push({ chatId, at: stretch.lines });
        continue;
      }
      if (stretch.transcript.length > room && parts.length) {
        leftover = true;
        continue;
      }
      if (stretch.lines < this.deps.chats.entryCount(chatId, agentId)) leftover = true;
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
    state.setCursors(job.name, agentId, cursorUpdates);
    return { parts, busy, leftover };
  }

  private async run(job: PassJob, agentId: string, chatIds: string[], force: boolean): Promise<RunOutcome> {
    const started = this.now();
    const agentKey = `${job.name}\u0000${agentId}`;
    const keyOf = (chatId: string) => `${agentKey}\u0000${chatId}`;
    const { state } = this.deps;
    let parts: PassPart[] = [];
    let requestId: string | null = null;
    const finish = (outcome: RunOutcome, extra: Partial<PassSummary> = {}) => {
      const read = parts.reduce((n, p) => n + p.lines - p.from, 0);
      this.deps.onPass?.({
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
      const on = await this.engineFor(agentId, record?.model ?? "");
      if (!on) return "skipped";
      const agentName = record?.name ?? null;
      const gathered = await this.gather(job, agentId, chatIds, agentName, force);
      parts = gathered.parts;
      if (!parts.length) return gathered.busy ? "skipped" : finish("nothing");
      const sharedRoot = sharedMemoryRoot(this.deps.backendDir);
      const signals = job.name === "reflection" && this.deps.collectSignals ? this.deps.collectSignals(agentId, state.signalsAt(agentId)) : null;
      const goals = job.name === "reflection" && this.deps.goalsSummary ? this.deps.goalsSummary(agentId) : null;
      const input: PassInput = {
        agentId,
        agentName,
        memoryRoot: memoryRoot(this.deps.backendDir, agentId),
        sharedMemoryRoot: sharedRoot,
        ...(signals ? { signals } : {}),
        ...(goals ? { goals } : {}),
        parts,
        material: batchText(parts),
        now: started,
      };
      const advance = () => {
        state.setCursors(
          job.name,
          agentId,
          parts.map((p) => ({ chatId: p.chatId, at: p.lines })),
        );
        if (job.name === "reflection" && signals) state.setSignalsAt(agentId, started.toISOString());
      };
      const prompt = await job.prompt(input);
      if (prompt === null) {
        advance();
        return finish("nothing");
      }
      // Outside (pi-durable): it answers a repeated request id with the old submission, and the pass chat is reset, not
      // recreated, so each attempt gets its own id and a retry is really asked again.
      const which = createHash("sha256")
        .update(parts.map((p) => `${p.chatId}@${p.lines}`).join("\n"))
        .digest("hex")
        .slice(0, 12);
      requestId = `pass:${job.name}:${agentId}:${which}:${started.getTime().toString(36)}`;
      const answer = await this.ask(agentId, record?.model ?? "", on, {
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
      return finish(result.capped ? "capped" : wrote ? "changed" : "nothing", { items: result.items, engine: engineName(on) });
    } catch (error) {
      for (const c of parts.length ? parts.map((p) => p.chatId) : chatIds) this.failedAt.set(keyOf(c), this.now().getTime());
      this.deps.report?.(`${job.name} on ${(parts.length ? parts.map((p) => p.chatId) : chatIds).join(", ")} failed: ${String(error)}`);
      return finish("failed");
    }
  }

  private async engineFor(agentId: string, model: string): Promise<PassEngine | null> {
    if (!this.deps.canRun || (await this.deps.canRun(model))) return { kind: "loki" };
    if (!this.deps.acp || !this.deps.state.settings().acp.enabled) return null;
    const engine = await this.deps.acp.engineFor(agentId);
    return engine ? { kind: "acp", engine } : null;
  }

  private runLimitMs(): number {
    return this.deps.runTimeoutMs ?? PASS_RUN_TIMEOUT_MS;
  }

  private async ask(agentId: string, agentModel: string, on: PassEngine, spec: PassSpec, timeoutMs = this.runLimitMs()): Promise<PassAnswer> {
    const content = `${spec.prompt}\n\n${daemonTimeReminder(this.now())}`;
    if (on.kind === "acp" && this.deps.acp)
      return this.deps.acp.ask(agentId, on.engine, { ...spec, prompt: content, chatId: `${spec.chatId}${ACP_PASS_SUFFIX}`, timeoutMs });
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
    const lastOldEntry = await store.newestEntryId(chat, context);
    // react-doctor-disable-next-line react-doctor/server-sequential-independent-await
    const submission = await chat.submit({ type: "input", content, requestId: spec.requestId }, context);
    const limited = withCancel(context);
    const timer = setTimeout(() => limited.cancel(new Error("timed out")), timeoutMs);
    let settled: Awaited<ReturnType<typeof submission.wait>>;
    try {
      settled = await submission.wait(limited.context);
    } catch (error) {
      if (!limited.context.abortSignal?.aborted) throw error;
      await chat.abort(context).catch(() => {});
      throw new Error(`the pass did not finish within ${Math.round(timeoutMs / 1000)}s`);
    } finally {
      clearTimeout(timer);
    }
    if (settled.status !== "done") throw new Error(`the pass did not finish: ${unansweredWhy(settled)}`);
    const answer: PassAnswer = { text: "", toolCalls: [] };
    const added: EntryRecord[] = [];
    await store.eachEntry(chat, context, (entry) => added.push(entry), lastOldEntry);
    for (const entry of added) {
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

  async runDoctor(agentId: string): Promise<DoctorResult> {
    const key = `doctor\u0000${agentId}`;
    if (this.queued.has(key)) return { outcome: "skipped", changes: 0, report: "a memory review of this agent is already running" };
    const deadline = this.now().getTime() + this.runLimitMs();
    const result = this.schedule([key], () => this.doctor(agentId, deadline), "next");
    void this.drain();
    return result;
  }

  private async doctor(agentId: string, deadline: number): Promise<DoctorResult> {
    const started = this.now();
    const requestId = `pass:doctor:${agentId}:${started.getTime().toString(36)}`;
    const finish = (result: DoctorResult, extra: Partial<PassSummary> = {}) => {
      this.deps.onPass?.({
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
      const on = await this.engineFor(agentId, record?.model ?? "");
      if (!on)
        return finish({
          outcome: "skipped",
          changes: 0,
          report:
            "the memory review runs on the agent's own model or, without one, on the agent's Claude Code or Cursor chats, and it has neither loki can reach; connect a provider in Preferences › Providers",
        });
      const root = memoryRoot(this.deps.backendDir, agentId);
      const sharedRoot = sharedMemoryRoot(this.deps.backendDir);
      const dump = memoryDump(root, undefined, sharedRoot);
      if (!dump.files) return finish({ outcome: "nothing", changes: 0, report: "this agent has no memory to review yet" });
      const left = deadline - this.now().getTime();
      if (left <= 0)
        return finish({ outcome: "skipped", changes: 0, report: "the other memory passes ran long, so the review did not start; run /doctor again" });
      const answer = await this.ask(
        agentId,
        record?.model ?? "",
        on,
        {
          chatId: doctorChatId(agentId),
          title: "doctor",
          instructions: DOCTOR_INSTRUCTIONS,
          tools: DOCTOR_TOOLS,
          prompt: doctorPrompt(dump, started, overBudget(root, sharedRoot)),
          requestId,
        },
        left,
      );
      const changes = answer.toolCalls.filter((t) => t !== "memory_read" && t !== "memory_search" && MEMORY_TOOLS.includes(t)).length;
      const report = answer.text || (changes ? `${changes} change${changes === 1 ? "" : "s"} to memory` : "memory looks healthy");
      return finish({ outcome: changes ? "changed" : "nothing", changes, report }, { files: dump.files, chars: dump.chars, engine: engineName(on) });
    } catch (error) {
      this.deps.report?.(`memory review of ${agentId} failed: ${String(error)}`);
      return finish({ outcome: "failed", changes: 0, report: `the memory review did not finish: ${messageOf(error)}` });
    }
  }

  private stretch(
    job: PassJob,
    chatId: string,
    agentId: string,
    from: number,
    agentName: string | null,
  ): { rows: TranscriptRow[]; lines: number; transcript: string } {
    const failedCalls = job.failedCalls === true;
    const read = (to?: number) => {
      const { rows, lines } = this.deps.chats.since(chatId, agentId, from, to, failedCalls);
      return { rows, lines, transcript: formatTranscript(rows, agentName, { failedCalls }) };
    };
    const all = read();
    if (all.transcript.length <= MAX_MATERIAL_CHARS) return all;
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

const engineName = (on: PassEngine): string => (on.kind === "loki" ? "loki" : `acp:${on.engine.agent}`);
