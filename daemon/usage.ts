import type { Context } from "@earendil-works/chord";
import type { CommitPublication, ConversationId, UsageState } from "@earendil-works/pi-durable";
import { createReadStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { isWriterChat } from "../core/learn/model.ts";
import { isSubagentChat } from "../core/subagents.ts";
import { hourOf, type UsageOrigin, type UsageRow } from "../core/usage.ts";
import { doctorChatId } from "./doctor.ts";
import { ACP_PASS_SUFFIX } from "./memory.ts";
import type { AgentStore } from "./kernel/index.ts";
import type { StoreManager } from "./kernel/stores.ts";
import { serialQueue } from "../core/serial.ts";
import { Listeners } from "../core/listeners.ts";
import { writeJsonAtomic } from "../mod/json-file.ts";

export const KEEP_DAYS = 400;
const SAVE_DELAY_MS = 1000;

/** A chat's totals for one model, as the ledger remembers them (the counters of pi-ai's `Usage` it reads). */
interface Counters {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  reasoning: number;
  cost_input: number;
  cost_output: number;
  cost_cache_read: number;
  cost_cache_write: number;
  cost_total: number;
}

/** The file: the rows, and each agent's chats' last totals by model, keyed by pi-durable's conversation id. */
interface LedgerFile {
  version: 1;
  rows: UsageRow[];
  seen: Partial<Record<string, Partial<Record<string, Partial<Record<string, Counters>>>>>>;
  /** When history from `events.jsonl` was seeded up to (KD6); missing until the seed has run. */
  seeded_until?: string;
}

const ZERO: Counters = {
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
  reasoning: 0,
  cost_input: 0,
  cost_output: 0,
  cost_cache_read: 0,
  cost_cache_write: 0,
  cost_total: 0,
};

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function countersOf(usage: unknown): Counters {
  const u = (usage ?? {}) as Record<string, unknown>;
  const cost = (u.cost ?? {}) as Record<string, unknown>;
  return {
    input: num(u.input),
    output: num(u.output),
    cache_read: num(u.cacheRead),
    cache_write: num(u.cacheWrite),
    reasoning: num(u.reasoning),
    cost_input: num(cost.input),
    cost_output: num(cost.output),
    cost_cache_read: num(cost.cacheRead),
    cost_cache_write: num(cost.cacheWrite),
    cost_total: num(cost.total),
  };
}

function modelCounters(state: Readonly<Partial<UsageState>> | null | undefined): Partial<Record<string, Counters>> {
  return Object.fromEntries(Object.entries(state?.models ?? {}).map(([model, usage]) => [model, countersOf(usage)]));
}

function growth(before: Counters, now: Counters): Counters | null {
  const reset =
    now.input < before.input ||
    now.output < before.output ||
    now.cache_read < before.cache_read ||
    now.cache_write < before.cache_write ||
    now.reasoning < before.reasoning ||
    now.cost_input < before.cost_input ||
    now.cost_output < before.cost_output ||
    now.cost_cache_read < before.cost_cache_read ||
    now.cost_cache_write < before.cost_cache_write ||
    now.cost_total < before.cost_total;
  const d: Counters = reset
    ? { ...now }
    : {
        input: now.input - before.input,
        output: now.output - before.output,
        cache_read: now.cache_read - before.cache_read,
        cache_write: now.cache_write - before.cache_write,
        reasoning: now.reasoning - before.reasoning,
        cost_input: now.cost_input - before.cost_input,
        cost_output: now.cost_output - before.cost_output,
        cost_cache_read: now.cost_cache_read - before.cost_cache_read,
        cost_cache_write: now.cost_cache_write - before.cost_cache_write,
        cost_total: now.cost_total - before.cost_total,
      };
  if (
    d.input > 0 ||
    d.output > 0 ||
    d.cache_read > 0 ||
    d.cache_write > 0 ||
    d.reasoning > 0 ||
    d.cost_input > 0 ||
    d.cost_output > 0 ||
    d.cost_cache_read > 0 ||
    d.cost_cache_write > 0 ||
    d.cost_total > 0
  ) {
    return d;
  }
  return null;
}

const ORIGIN_OF_TURN: Partial<Record<string, UsageOrigin>> = {
  message: "chats",
  schedule: "chats",
  background: "chats",
  subagent: "helpers",
  learn: "learn",
  recall: "learn",
  reflection: "reflection",
  doctor: "doctor",
  advisor: "helpers",
};

export function originOfChat(chatId: string, agentId: string): UsageOrigin {
  if (isSubagentChat(chatId) || chatId.startsWith("advisor-")) return "helpers";
  if (isWriterChat(chatId)) return "learn";
  const own = chatId.endsWith(ACP_PASS_SUFFIX) ? chatId.slice(0, -ACP_PASS_SUFFIX.length) : chatId;
  if (own === `reflection-${agentId}`) return "reflection";
  if (own === doctorChatId(agentId)) return "doctor";
  return "chats";
}

export interface UsageLedgerDeps {
  file: string;
  context: Context;
  inputRate: (model: string) => number | null;
  now?: () => number;
  report?: (message: string) => void;
  eventsFiles?: readonly string[];
  saveDelayMs?: number;
}

export class UsageLedger {
  private readonly deps: UsageLedgerDeps;
  private readonly now: () => number;
  private readonly rowsByKey = new Map<string, UsageRow>();
  private seen: LedgerFile["seen"] = {};
  private readonly origins = new Map<string, Promise<UsageOrigin>>();
  private readonly unsubscribe = new Map<string, () => void>();
  private readonly serial = serialQueue();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seededUntil: string | null = null;
  private dirty = false;
  private cachedRows: UsageRow[] | null = null;
  private readonly listeners = new Listeners();

  constructor(deps: UsageLedgerDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.load();
    if (this.seededUntil === null) {
      const rows = this.rows();
      const until = rows.length ? rows[0].hour : new Date(this.now()).toISOString();
      this.enqueue(() => this.seed(until));
    }
  }

  seeded(): string | null {
    return this.seededUntil;
  }

  follow(stores: StoreManager): () => void {
    return stores.onOpen((agentId, store) => {
      this.attach(agentId, store);
    });
  }

  attach(agentId: string, store: AgentStore): void {
    this.unsubscribe.get(agentId)?.();
    this.unsubscribe.set(
      agentId,
      store.harness.subscribeCommits((publication) => {
        if (!publication.changes.some((c) => c.type === "document" && c.record.kind === "pi.usage" && c.conversationId !== undefined && Boolean(c.value)))
          return;
        const at = this.now();
        this.enqueue(() => this.apply(agentId, store, publication, at));
      }),
    );
    this.enqueue(() => this.baseline(agentId, store));
  }

  onChange(listener: () => void): () => void {
    return this.listeners.add(listener);
  }

  rows(): UsageRow[] {
    return (this.cachedRows ??= [...this.rowsByKey.values()].sort((a, b) => a.hour.localeCompare(b.hour)));
  }

  settled(): Promise<void> {
    return this.serial(() => Promise.resolve());
  }

  close(): void {
    for (const off of this.unsubscribe.values()) off();
    this.unsubscribe.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.dirty) this.save();
  }

  save(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.prune();
    const data: LedgerFile = { version: 1, rows: this.rows(), seen: this.seen, ...(this.seededUntil ? { seeded_until: this.seededUntil } : {}) };
    try {
      writeJsonAtomic(this.deps.file, data);
      this.dirty = false;
    } catch (error) {
      this.deps.report?.(`usage: could not save ${this.deps.file}: ${String(error)}`);
    }
  }

  private enqueue(work: () => Promise<void>): void {
    void this.serial(work).catch((error: unknown) => {
      this.deps.report?.(`usage: ${String(error)}`);
    });
  }

  private load(): void {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.deps.file, "utf8"));
    } catch {
      return;
    }
    const file = raw as Partial<LedgerFile> | null;
    for (const row of Array.isArray(file?.rows) ? file.rows : []) {
      const origin = (row.origin as string) === "advisor" ? "helpers" : row.origin;
      const normalized = origin === row.origin ? row : { ...row, origin };
      const existing = this.rowsByKey.get(keyOf(normalized));
      if (existing) {
        existing.input_tokens += normalized.input_tokens;
        existing.cache_read_tokens += normalized.cache_read_tokens;
        existing.cache_write_tokens += normalized.cache_write_tokens;
        existing.output_tokens += normalized.output_tokens;
        existing.reasoning_tokens += normalized.reasoning_tokens;
        existing.cost.input += normalized.cost.input;
        existing.cost.cache_read += normalized.cost.cache_read;
        existing.cost.cache_write += normalized.cost.cache_write;
        existing.cost.output += normalized.cost.output;
        existing.cost.other += normalized.cost.other;
        existing.cost.total += normalized.cost.total;
        existing.cache_read_as_input += normalized.cache_read_as_input;
      } else {
        this.rowsByKey.set(keyOf(normalized), normalized);
      }
    }
    this.seen = file?.seen && typeof file.seen === "object" ? file.seen : {};
    this.seededUntil = typeof file?.seeded_until === "string" ? file.seeded_until : null;
    this.prune();
  }

  private prune(): void {
    const oldest = hourOf(this.now() - KEEP_DAYS * 86_400_000);
    let pruned = false;
    for (const [key, row] of this.rowsByKey) {
      if (row.hour < oldest) {
        this.rowsByKey.delete(key);
        pruned = true;
      }
    }
    if (pruned) {
      this.cachedRows = null;
      this.dirty = true;
    }
  }

  private changed(): void {
    this.dirty = true;
    this.listeners.emit();
    this.scheduleSave();
  }

  private scheduleSave(): void {
    this.dirty = true;
    const delay = this.deps.saveDelayMs ?? SAVE_DELAY_MS;
    if (delay === 0 || this.timer) return;
    this.timer = setTimeout(() => {
      this.save();
    }, delay);
    this.timer.unref();
  }

  private async seed(until: string): Promise<void> {
    const cutoff = Date.parse(until);
    for (const path of this.deps.eventsFiles ?? []) {
      let lines: AsyncIterable<string>;
      try {
        lines = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
        for await (const line of lines) this.seedLine(line, cutoff);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.deps.report?.(`usage: could not seed from ${path}: ${String(error)}`);
      }
    }
    this.seededUntil = until;
    this.changed();
  }

  private seedLine(line: string, cutoff: number): void {
    if (!line.includes('"turn_finished"')) return;
    let event: { event?: unknown; timestamp?: unknown; properties?: Record<string, unknown> };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      return;
    }
    const at = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : NaN;
    const p = event.properties;
    if (event.event !== "turn_finished" || !p || !(at < cutoff) || typeof p.agent !== "string") return;
    const model = typeof p.model === "string" ? p.model : "unknown";
    const cost = num(p.cost);
    const d: Counters = {
      ...ZERO,
      input: num(p.input_tokens),
      output: num(p.output_tokens),
      cache_read: num(p.cache_read_tokens),
      cache_write: num(p.cache_write_tokens),
      reasoning: num(p.reasoning_tokens),
    };
    if (!growth(ZERO, d) && cost === 0) return;
    const row = this.add(hourOf(at), p.agent, model, ORIGIN_OF_TURN[String(p.origin)] ?? "chats", d);
    row.cost.other += cost;
    row.cost.total += cost;
  }

  private async baseline(agentId: string, store: AgentStore): Promise<void> {
    const seen = (this.seen[agentId] ??= {});
    const unseen = (await store.chatConversations(this.deps.context)).filter((id) => !seen[String(id)]);
    const totals = await Promise.all(unseen.map((id) => store.usage(id, this.deps.context)));
    unseen.forEach((id, i) => {
      seen[String(id)] ??= modelCounters(totals[i]);
    });
    if (unseen.length) this.scheduleSave();
  }

  private async apply(agentId: string, store: AgentStore, publication: CommitPublication, at: number): Promise<void> {
    let grew = false;
    for (const change of publication.changes) {
      if (change.type !== "document" || change.record.kind !== "pi.usage" || change.conversationId === undefined || !change.value) continue;
      const conversationId = change.conversationId;
      const seen = (this.seen[agentId] ??= {});
      const now = modelCounters(change.value);
      const before = seen[String(conversationId)];
      seen[String(conversationId)] = now;
      if (!before) {
        this.scheduleSave();
        if (change.ops.length > 0) continue;
      }
      const hour = hourOf(at);
      const growths = Object.entries(now).flatMap(([model, counters]) => {
        const d = counters ? growth(before?.[model] ?? ZERO, counters) : null;
        return d ? [{ model, d }] : [];
      });
      if (growths.length) {
        const origin = await this.originOf(agentId, store, conversationId);
        for (const { model, d } of growths) this.add(hour, agentId, model, origin, d);
        grew = true;
      }
    }
    if (grew) this.changed();
  }

  private originOf(agentId: string, store: AgentStore, conversationId: ConversationId): Promise<UsageOrigin> {
    const key = `${agentId}\u0000${String(conversationId)}`;
    let origin = this.origins.get(key);
    if (!origin) {
      origin = (async () => {
        const info = await store.chatInfo(conversationId, this.deps.context);
        return info?.id && info.helper_for === undefined ? originOfChat(info.id, agentId) : "helpers";
      })();
      this.origins.set(key, origin);
    }
    return origin;
  }

  private add(hour: string, agentId: string, model: string, origin: UsageOrigin, d: Counters): UsageRow {
    const key = keyOf({ hour, agent_id: agentId, model, origin });
    const row = this.rowsByKey.get(key) ?? emptyRow(hour, agentId, model, origin);
    row.input_tokens += d.input;
    row.cache_read_tokens += d.cache_read;
    row.cache_write_tokens += d.cache_write;
    row.output_tokens += d.output;
    row.reasoning_tokens += d.reasoning;
    row.cost.input += d.cost_input;
    row.cost.cache_read += d.cost_cache_read;
    row.cost.cache_write += d.cost_cache_write;
    row.cost.output += d.cost_output;
    row.cost.total += d.cost_total;
    row.cache_read_as_input += (d.cache_read * (this.deps.inputRate(model) ?? 0)) / 1_000_000;
    this.rowsByKey.set(key, row);
    this.cachedRows = null;
    return row;
  }
}

const keyOf = (row: Pick<UsageRow, "hour" | "agent_id" | "model" | "origin">) => `${row.hour}\u0000${row.agent_id}\u0000${row.model}\u0000${row.origin}`;

function emptyRow(hour: string, agentId: string, model: string, origin: UsageOrigin): UsageRow {
  return {
    hour,
    agent_id: agentId,
    model,
    origin,
    input_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cost: { input: 0, cache_read: 0, cache_write: 0, output: 0, other: 0, total: 0 },
    cache_read_as_input: 0,
  };
}
