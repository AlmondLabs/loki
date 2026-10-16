import type { Context } from "@earendil-works/chord";
import type { CommitPublication, ConversationId, UsageState } from "@earendil-works/pi-durable";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isWriterChat } from "../core/recall/model.ts";
import { hourOf, type UsageOrigin, type UsageRow } from "../core/usage.ts";
import { doctorChatId } from "./doctor.ts";
import type { AgentStore } from "./kernel/index.ts";
import type { StoreManager } from "./kernel/stores.ts";

/**
 * The usage ledger (docs/plans/2026-10-17-019-feat-loki-usage-page-plan.md, KD4): what every model call cost, by
 * hour, agent, model and origin, in `~/.loki/state/usage.json`, for the usage page. pi-durable already adds each
 * call's tokens and cost into its chat's `pi.usage` (by model, compaction's calls included), but with no time. So the
 * ledger follows every store's commits and, when a chat's totals grow, adds the difference to the current hour. It
 * remembers each chat's last totals in the same file, so a restart counts nothing twice, and on opening a store it
 * takes the totals of chats it has never seen as already counted, so history from before the ledger never lands in
 * the hour it first runs. The ledger is the person's own record: it does not depend on analytics being on.
 */

/** Rows older than this are dropped, which keeps the file to a few thousand rows a year. */
export const KEEP_DAYS = 400;
/** How long after a change the file is written, so a busy turn writes it once. */
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

/** The counters of one `pi.usage` entry, whatever a provider left out read as zero. */
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

/** Each model's counters in a `pi.usage` value. */
function modelCounters(state: Readonly<Partial<UsageState>> | null | undefined): Partial<Record<string, Counters>> {
  return Object.fromEntries(Object.entries(state?.models ?? {}).map(([model, usage]) => [model, countersOf(usage)]));
}

/**
 * What grew from `before` to `now`, or null when nothing did. A counter that went down means the totals started
 * again (a conversation recreated under the same id), so the new total is the growth.
 */
function growth(before: Counters, now: Counters): Counters | null {
  const keys = Object.keys(ZERO) as Array<keyof Counters>;
  const reset = keys.some((k) => now[k] < before[k]);
  const d = Object.fromEntries(keys.map((k) => [k, reset ? now[k] : now[k] - before[k]])) as unknown as Counters;
  return keys.some((k) => d[k] > 0) ? d : null;
}

/** Whose work a chat's calls are, by its id: a background pass's hidden chat, else the person's. */
export function originOfChat(chatId: string, agentId: string): UsageOrigin {
  if (isWriterChat(chatId)) return "learn";
  if (chatId === `reflection-${agentId}`) return "reflection";
  if (chatId === doctorChatId(agentId)) return "doctor";
  return "chats";
}

/** What the ledger needs: its file, the price of a model's input (dollars per million tokens), and the clock. */
export interface UsageLedgerDeps {
  file: string;
  context: Context;
  /** `provider/modelId`'s input price per million tokens, or null when pi-ai has none. */
  inputRate: (model: string) => number | null;
  /** Whether an agent is a helper agent (the Letta-era subagent records), whose calls count as helpers. */
  isSubagent?: (agentId: string) => boolean;
  now?: () => number;
  report?: (message: string) => void;
  /** Writes the file this long after a change; tests pass 0 and call `save()`. */
  saveDelayMs?: number;
}

/** The ledger: follow the stores, then read `rows()`. */
export class UsageLedger {
  private readonly deps: UsageLedgerDeps;
  private readonly now: () => number;
  private readonly rowsByKey = new Map<string, UsageRow>();
  private seen: LedgerFile["seen"] = {};
  private readonly origins = new Map<string, Promise<UsageOrigin>>();
  private readonly unsubscribe = new Map<string, () => void>();
  /** Every change is applied in order, after any baseline of its store. */
  private queue: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: UsageLedgerDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.load();
  }

  /** Follow every store as it opens; returns the unsubscribe. */
  follow(stores: StoreManager): () => void {
    return stores.onOpen((agentId, store) => {
      this.attach(agentId, store);
    });
  }

  /** Follow one store: take its unseen chats' totals as counted, then count what grows. */
  attach(agentId: string, store: AgentStore): void {
    this.unsubscribe.get(agentId)?.();
    this.unsubscribe.set(
      agentId,
      store.harness.subscribeCommits((publication) => {
        // The hour is the commit's, taken now: the change waits its turn behind slower work.
        const at = this.now();
        this.enqueue(() => this.apply(agentId, store, publication, at));
      }),
    );
    this.enqueue(() => this.baseline(agentId, store));
  }

  /** Every row, oldest hour first. */
  rows(): UsageRow[] {
    return [...this.rowsByKey.values()].sort((a, b) => a.hour.localeCompare(b.hour));
  }

  /** Waits until every change seen so far is counted. */
  settled(): Promise<void> {
    return this.queue;
  }

  /** Stop following, and write what is pending. */
  close(): void {
    for (const off of this.unsubscribe.values()) off();
    this.unsubscribe.clear();
    this.save();
  }

  /** Write the file now. */
  save(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.prune();
    const data: LedgerFile = { version: 1, rows: this.rows(), seen: this.seen };
    try {
      mkdirSync(dirname(this.deps.file), { recursive: true });
      writeFileSync(`${this.deps.file}.tmp`, JSON.stringify(data));
      renameSync(`${this.deps.file}.tmp`, this.deps.file);
    } catch (error) {
      this.deps.report?.(`usage: could not save ${this.deps.file}: ${String(error)}`);
    }
  }

  private enqueue(work: () => Promise<void>): void {
    this.queue = this.queue.then(work).catch((error: unknown) => {
      this.deps.report?.(`usage: ${String(error)}`);
    });
  }

  private load(): void {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.deps.file, "utf8"));
    } catch {
      return; // no ledger yet, or one that cannot be read: start empty
    }
    const file = raw as Partial<LedgerFile> | null;
    for (const row of Array.isArray(file?.rows) ? file.rows : []) this.rowsByKey.set(keyOf(row), row);
    this.seen = file?.seen && typeof file.seen === "object" ? file.seen : {};
    this.prune();
  }

  private prune(): void {
    const oldest = hourOf(this.now() - KEEP_DAYS * 86_400_000);
    for (const [key, row] of this.rowsByKey) if (row.hour < oldest) this.rowsByKey.delete(key);
  }

  private scheduleSave(): void {
    const delay = this.deps.saveDelayMs ?? SAVE_DELAY_MS;
    if (delay === 0 || this.timer) return;
    this.timer = setTimeout(() => {
      this.save();
    }, delay);
    this.timer.unref();
  }

  /** Take the current totals of every chat the ledger has not seen as already counted. */
  private async baseline(agentId: string, store: AgentStore): Promise<void> {
    const seen = (this.seen[agentId] ??= {});
    let changed = false;
    for (const id of await store.chatConversations(this.deps.context)) {
      if (seen[String(id)]) continue;
      seen[String(id)] = modelCounters(await store.usage(id, this.deps.context));
      changed = true;
    }
    if (changed) this.scheduleSave();
  }

  private async apply(agentId: string, store: AgentStore, publication: CommitPublication, at: number): Promise<void> {
    for (const change of publication.changes) {
      if (change.type !== "document" || change.record.kind !== "pi.usage" || change.conversationId === undefined || !change.value) continue;
      const conversationId = change.conversationId;
      const seen = (this.seen[agentId] ??= {});
      const now = modelCounters(change.value);
      const before = seen[String(conversationId)];
      seen[String(conversationId)] = now;
      // A chat first seen mid-life (its creation came before the ledger followed it): its totals so far are history.
      if (!before && change.ops.length > 0) continue;
      const hour = hourOf(at);
      for (const [model, counters] of Object.entries(now)) {
        if (!counters) continue;
        const d = growth(before?.[model] ?? ZERO, counters);
        if (d) this.add(hour, agentId, model, await this.originOf(agentId, store, conversationId), d);
      }
      this.scheduleSave();
    }
  }

  private originOf(agentId: string, store: AgentStore, conversationId: ConversationId): Promise<UsageOrigin> {
    const key = `${agentId}\u0000${String(conversationId)}`;
    let origin = this.origins.get(key);
    if (!origin) {
      origin = (async () => {
        if (this.deps.isSubagent?.(agentId)) return "helpers";
        const info = await store.chatInfo(conversationId, this.deps.context);
        // A conversation with no chat of loki's is a helper's child conversation.
        return info?.id ? originOfChat(info.id, agentId) : "helpers";
      })();
      this.origins.set(key, origin);
    }
    return origin;
  }

  private add(hour: string, agentId: string, model: string, origin: UsageOrigin, d: Counters): void {
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
