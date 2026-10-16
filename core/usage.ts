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
