/**
 * How long "later" hides a card: a geometric ladder, first · growth^(n−1) minutes for the n-th deferral
 * of the same card in a day, capped at a day. Two knobs, because a ladder has two: how long the first
 * deferral lasts (the one you feel — does the card come back inside this pass or after the next coffee),
 * and how much faster each further one gets. Defaults 10 minutes and ×3: 10m · 30m · 1h30 · 4h30 · 13h30 · 1d.
 * Shared by the deck (core/attention/snooze.ts) and the mod, which keeps the setting beside the seen markers.
 */
export interface SnoozeLadder {
  firstMinutes: number;
  growth: number;
}

export const DEFAULT_LADDER: SnoozeLadder = { firstMinutes: 10, growth: 3 };
export const LADDER_RANGE = { firstMinutes: { min: 1, max: 1440 }, growth: { min: 1, max: 10 } } as const;
/** No deferral outlives the day; the daily reset would void it anyway. */
export const MAX_SNOOZE_MS = 24 * 60 * 60_000;

const clamp = (v: unknown, range: { min: number; max: number }, fallback: number): number => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(range.max, Math.max(range.min, n));
};

/** A ladder from loose input (a settings frame, a file): each knob within its range, else the default. */
export function clampLadder(input: Partial<Record<keyof SnoozeLadder, unknown>> | null | undefined, base: SnoozeLadder = DEFAULT_LADDER): SnoozeLadder {
  return {
    firstMinutes: clamp(input?.firstMinutes ?? base.firstMinutes, LADDER_RANGE.firstMinutes, DEFAULT_LADDER.firstMinutes),
    growth: clamp(input?.growth ?? base.growth, LADDER_RANGE.growth, DEFAULT_LADDER.growth),
  };
}

/** The gap before the n-th deferral (1-based) of a card comes back, in milliseconds. */
export function snoozeGapMs(skips: number, ladder: SnoozeLadder = DEFAULT_LADDER): number {
  const n = Math.max(1, Math.floor(skips));
  return Math.min(MAX_SNOOZE_MS, Math.round(ladder.firstMinutes * 60_000 * Math.pow(ladder.growth, n - 1)));
}

/** The ladder's first steps, for showing it: stops after the step that reaches the cap. */
export function ladderSteps(ladder: SnoozeLadder = DEFAULT_LADDER, max = 6): number[] {
  const out: number[] = [];
  for (let n = 1; n <= max; n++) {
    const gap = snoozeGapMs(n, ladder);
    out.push(gap);
    if (gap >= MAX_SNOOZE_MS) break;
  }
  return out;
}

/** "10m", "1h 30m", "4h", "1d" — a gap as people say it. */
export function formatGap(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  if (m >= 24 * 60) return `${Math.round(m / (24 * 60))}d`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h}h ${rest}m` : `${h}h`;
}
