/** A closed numeric range, and the clamp every knob in Settings goes through. */
export interface Range {
  readonly min: number;
  readonly max: number;
}

/** `v` within the range; a value that is not a finite number becomes `fallback`. */
export function clamp(v: unknown, range: Range, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(range.max, Math.max(range.min, n));
}

/** True when `v` reads as a finite number inside the range — the check a typed knob passes before it is applied. */
export function within(v: unknown, range: Range): boolean {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= range.min && n <= range.max;
}
