/**
 * Where one turn's time went (plan 017, R2): waiting for the model, running tools, or the harness itself. pi-durable
 * saves each model response with the time it started and ended, and each tool result with when it finished, so one
 * function measures a turn from what the store saved, plus two
 * moments only a client sees: when the message was sent and when its first word arrived.
 */

/** A stretch of time in milliseconds since the epoch. */
export interface Span {
  start: number;
  end: number;
}

/** One turn's moments and spans, in milliseconds since the epoch: when the message was sent, and what the store saved. */
export interface TurnInput {
  sentAt: number;
  /** When the first streamed text or tool call reached the client; null when none did. */
  firstOutputAt: number | null;
  /** Model responses, each from its request to its last token. */
  models: Span[];
  /** Tool calls, each from its start to its result. */
  tools: Span[];
  /** When the client saw the turn end; absent, the end of the last response or tool. */
  endAt?: number;
}

/** Where one turn's time went, in milliseconds; a null is a moment the turn never reached. */
export interface TurnTimings {
  /** Send to the first streamed output. */
  ttftMs: number | null;
  /** Send to the end of the turn. */
  totalMs: number;
  /** Time the model was working; responses that overlap count once. */
  modelMs: number;
  /** Time a tool was running and the model was not. */
  toolMs: number;
  /** Everything else: the harness between the send and the end. */
  overheadMs: number;
  /** Send to the first request reaching the model. */
  beforeFirstRequestMs: number | null;
  /** For each tool result, the time until the next model request started. */
  afterToolMs: number[];
}

/** Total length of a set of spans, overlaps counted once. */
export function covered(spans: readonly Span[]): number {
  const sorted = [...spans].filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  let total = 0;
  let open: Span | null = null;
  for (const s of sorted) {
    if (open && s.start <= open.end) {
      open.end = Math.max(open.end, s.end);
      continue;
    }
    if (open) total += open.end - open.start;
    open = { ...s };
  }
  return open ? total + open.end - open.start : total;
}

/** Split one turn's time between the model, its tools and the harness. A tool's time counts only where no model response overlaps it, and the harness has the rest. */
export function turnTimings(turn: TurnInput): TurnTimings {
  const ends = [...turn.models, ...turn.tools].map((s) => s.end);
  const end = turn.endAt ?? (ends.length ? Math.max(...ends) : turn.sentAt);
  const totalMs = end - turn.sentAt;
  const modelMs = covered(turn.models);
  const busy = covered([...turn.models, ...turn.tools]);
  const starts = turn.models.map((s) => s.start).sort((a, b) => a - b);
  const afterToolMs = turn.tools.flatMap((tool) => {
    const next = starts.find((start) => start >= tool.end);
    return next === undefined ? [] : [next - tool.end];
  });
  return {
    ttftMs: turn.firstOutputAt === null ? null : turn.firstOutputAt - turn.sentAt,
    totalMs,
    modelMs,
    toolMs: busy - modelMs,
    overheadMs: totalMs - busy,
    beforeFirstRequestMs: starts.length ? starts[0] - turn.sentAt : null,
    afterToolMs,
  };
}

/** The median of some numbers; null for none. */
export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
