/**
 * What a finger meant when it let go, the way UIKit reads it (Apple's "Designing Fluid Interfaces"). A drag is
 * not judged by where it stopped but by where it was going: the release's speed is projected forward as a
 * scroll view decelerates, and the gesture commits when that resting place is past the line. One rule then
 * covers a long pull, a short flick, and a pull that turns back before it lets go (which stays).
 *
 * Used by the phone's sheets (components/sheet-motion.ts), the edge swipe back (phone/edge-swipe.ts) and the
 * Inbox card (phone/deck.ts).
 */

/** A pointer's place along the gesture's axis (px) at an event's timeStamp (ms). */
export interface Sample {
  at: number;
  t: number;
}

/**
 * How fast a scroll view slows: each millisecond keeps this share of the speed. UIKit's normal rate is 0.998 and
 * its fast one 0.99; loki's gestures sit between, so a flick commits at about the speeds the old flick thresholds
 * asked for (500–700 px/s from just past the slop).
 */
export const DECELERATION = 0.995;
/** The speed is read over this last stretch of the drag, ms: long enough to smooth jitter, short enough to be now. */
const SPEED_WINDOW = 60;
/** A finger that rested this long before letting go was not moving when it let go, ms. */
const HELD = 50;

/** Where a release at `velocity` (px/s) would come to rest, px from where it let go, as a scroll view decelerates. */
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

/**
 * Whether a release commits: moved past `slop` (else it was a tap) and projected, at `velocity` px/s, to rest at or
 * past `line` px. A flick back the other way projects short of it, so it stays.
 */
export function releaseCommits(distance: number, velocity: number, line: number, slop: number): boolean {
  return distance > slop && distance + project(velocity) >= line;
}

/**
 * Where an element is on screen right now along `axis`, px: its transform as painted, mid-animation included. A
 * gesture that catches a moving thing starts from here, never from where the animation was headed.
 */
export function onScreenOffset(el: Element, axis: "x" | "y"): number {
  const t = getComputedStyle(el).transform;
  if (!t || t === "none" || typeof DOMMatrixReadOnly === "undefined") return 0;
  const m = new DOMMatrixReadOnly(t);
  return axis === "x" ? m.m41 : m.m42;
}
