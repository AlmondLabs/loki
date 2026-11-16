export interface Span {
  start: number;
  end: number;
}

export interface TurnInput {
  sentAt: number;
  firstOutputAt: number | null;
  models: Span[];
  tools: Span[];
  endAt?: number;
}

export interface TurnTimings {
  ttftMs: number | null;
  totalMs: number;
  modelMs: number;
  toolMs: number;
  overheadMs: number;
  beforeFirstRequestMs: number | null;
  afterToolMs: number[];
}

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

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
