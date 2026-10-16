/**
 * What the agents spent, as the daemon's usage ledger keeps it (daemon/usage.ts) and the usage page reads it: one row
 * per hour, agent, model and origin, with the tokens and the estimated cost of every model call in it. Costs are what
 * the provider's API prices would charge (pi-ai's model table), in dollars; a subscription sign-in is billed by plan.
 */

/**
 * Whose work a call was: the person's own chats (with their scheduled prompts and background notices), a helper's
 * child conversation, or one of loki's background passes.
 */
export type UsageOrigin = "chats" | "helpers" | "reflection" | "learn" | "doctor";

/** A row's estimated cost by token type; `other` is cost known only as a total (history from before the ledger). */
export interface UsageCost {
  input: number;
  cache_read: number;
  cache_write: number;
  output: number;
  other: number;
  total: number;
}

/**
 * One hour of one agent's calls to one model for one origin. `reasoning_tokens` is part of `output_tokens`, never on
 * top of it. `cache_read_as_input` is what the cache reads would have cost as plain input, for the cache's savings.
 */
export interface UsageRow {
  /** The hour's start, UTC, as `2026-10-17T14:00:00.000Z`. */
  hour: string;
  agent_id: string;
  /** `provider/modelId`, as pi-durable keys it. */
  model: string;
  origin: UsageOrigin;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cost: UsageCost;
  cache_read_as_input: number;
}

/** The start of the UTC hour `ms` falls in, as a row's `hour`. */
export function hourOf(ms: number): string {
  const d = new Date(ms);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

/** What the page reads (`usage_get`): the rows in its period, which models pi-ai has a price for, and the seed's edge. */
export interface UsageReply {
  rows: UsageRow[];
  /** Each model in `rows`, and whether its cost is known; an unpriced model's tokens are counted, its cost is not. */
  priced: Partial<Record<string, boolean>>;
  /** History before this instant came from analytics and has no cost split by token type (null before the seed). */
  seeded_until: string | null;
}

/** Tokens by type; reasoning is part of output. */
export interface UsageTokens {
  input: number;
  cache_read: number;
  cache_write: number;
  output: number;
  reasoning: number;
  total: number;
}

/** One line of a breakdown: an agent, an origin or a model, with what it spent and its share of the cost. */
export interface UsageLine {
  key: string;
  cost: number;
  tokens: number;
  /** Its share of the period's cost, 0 to 1 (0 when nothing had a cost). */
  share: number;
}

/** One bar of the chart: a day (`2026-10-17`) or an hour (`2026-10-17T14`) in the reader's time zone. */
export interface UsagePoint {
  bucket: string;
  cost: number;
  tokens: number;
}

/** A period summed up for the page. */
export interface UsageSummary {
  cost: UsageCost;
  tokens: UsageTokens;
  /** What the cache reads saved against paying for them as plain input; history without a split counts none. */
  cache_savings: number;
  /** Tokens of models with no known price, left out of the cost. */
  unpriced_tokens: number;
  series: UsagePoint[];
  by_agent: UsageLine[];
  by_origin: UsageLine[];
  by_model: UsageLine[];
}

/** Which rows the page is narrowed to; each field unset means every one. */
export interface UsageFilter {
  agent_id?: string;
  origin?: UsageOrigin;
  model?: string;
}

const HOUR_MS = 3_600_000;

/** The reader's calendar day, or day and hour, of an instant, in `timeZone` (DST included). */
export function bucketOf(ms: number, timeZone: string, resolution: "day" | "hour"): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  return resolution === "day" ? day : `${day}T${parts.hour}`;
}

const rowTokens = (r: UsageRow) => r.input_tokens + r.cache_read_tokens + r.cache_write_tokens + r.output_tokens;

/**
 * Sum `rows` between `since` and `until` (instants, ms) for the page: totals, the chart's buckets (every one in the
 * period, empty ones included), and the breakdowns by agent, origin and model, each sorted by cost.
 */
export function summarize(
  rows: readonly UsageRow[],
  opts: { since: number; until: number; timeZone: string; resolution: "day" | "hour"; priced: UsageReply["priced"]; filter?: UsageFilter },
): UsageSummary {
  const { since, until, timeZone, resolution, priced, filter = {} } = opts;
  const cost: UsageCost = { input: 0, cache_read: 0, cache_write: 0, output: 0, other: 0, total: 0 };
  const tokens: UsageTokens = { input: 0, cache_read: 0, cache_write: 0, output: 0, reasoning: 0, total: 0 };
  let cacheSavings = 0;
  let unpriced = 0;
  const series = new Map<string, UsagePoint>();
  for (let t = Date.parse(hourOf(since)); t < until; t += HOUR_MS) {
    const bucket = bucketOf(t, timeZone, resolution);
    if (!series.has(bucket)) series.set(bucket, { bucket, cost: 0, tokens: 0 });
  }
  const lines = { agent: new Map<string, UsageLine>(), origin: new Map<string, UsageLine>(), model: new Map<string, UsageLine>() };
  const line = (map: Map<string, UsageLine>, key: string, c: number, n: number) => {
    const l = map.get(key) ?? { key, cost: 0, tokens: 0, share: 0 };
    l.cost += c;
    l.tokens += n;
    map.set(key, l);
  };
  for (const r of rows) {
    const at = Date.parse(r.hour);
    if (at < Date.parse(hourOf(since)) || at >= until) continue;
    if ((filter.agent_id && r.agent_id !== filter.agent_id) || (filter.origin && r.origin !== filter.origin) || (filter.model && r.model !== filter.model))
      continue;
    const n = rowTokens(r);
    tokens.input += r.input_tokens;
    tokens.cache_read += r.cache_read_tokens;
    tokens.cache_write += r.cache_write_tokens;
    tokens.output += r.output_tokens;
    tokens.reasoning += r.reasoning_tokens;
    tokens.total += n;
    const known = priced[r.model] === true;
    if (known) {
      cost.input += r.cost.input;
      cost.cache_read += r.cost.cache_read;
      cost.cache_write += r.cost.cache_write;
      cost.output += r.cost.output;
      cost.other += r.cost.other;
      cost.total += r.cost.total;
      if (r.cost.other === 0) cacheSavings += Math.max(0, r.cache_read_as_input - r.cost.cache_read);
    } else unpriced += n;
    const c = known ? r.cost.total : 0;
    const point = series.get(bucketOf(at, timeZone, resolution));
    if (point) {
      point.cost += c;
      point.tokens += n;
    }
    line(lines.agent, r.agent_id, c, n);
    line(lines.origin, r.origin, c, n);
    line(lines.model, r.model, c, n);
  }
  const sorted = (map: Map<string, UsageLine>) =>
    [...map.values()].map((l) => ({ ...l, share: cost.total > 0 ? l.cost / cost.total : 0 })).sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
  return {
    cost,
    tokens,
    cache_savings: cacheSavings,
    unpriced_tokens: unpriced,
    series: [...series.values()],
    by_agent: sorted(lines.agent),
    by_origin: sorted(lines.origin),
    by_model: sorted(lines.model),
  };
}
