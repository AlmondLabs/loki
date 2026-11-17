export interface Sample {
  at: number;
  t: number;
}

export const DECELERATION = 0.995;
const SPEED_WINDOW = 60;
const HELD = 50;

export function project(velocity: number, rate = DECELERATION): number {
  return ((velocity / 1000) * rate) / (1 - rate);
}

/**
 * The finger's speed at the moment it let go, px/s: over the last SPEED_WINDOW ms of samples, and 0 when it rested
 * HELD ms or more before `releasedAt` (no move events come while a finger is still, so the samples alone would
 * remember the last flick).
 */
export function releaseVelocity(samples: readonly Sample[], releasedAt: number): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  if (releasedAt - last.t >= HELD) return 0;
  let ref = samples[0];
  for (let i = samples.length - 2; i >= 0; i--) {
    ref = samples[i];
    if (last.t - ref.t >= SPEED_WINDOW) break;
  }
  const dt = last.t - ref.t;
  return dt > 0 ? ((last.at - ref.at) / dt) * 1000 : 0;
}

export function releaseCommits(distance: number, velocity: number, line: number, slop: number): boolean {
  return distance > slop && distance + project(velocity) >= line;
}

export function onScreenOffset(el: Element, axis: "x" | "y"): number {
  const t = getComputedStyle(el).transform;
  if (!t || t === "none" || typeof DOMMatrixReadOnly === "undefined") return 0;
  const m = new DOMMatrixReadOnly(t);
  return axis === "x" ? m.m41 : m.m42;
}
