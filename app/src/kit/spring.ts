/**
 * loki's motion is springs, the way Apple's is (SwiftUI's smooth, snappy and bouncy): a spring is a
 * perceptual duration and a bounce, not a clock and a curve. CSS cannot run a spring, but it can follow
 * one: `linear()` takes the spring's path sampled as points, and the animation lasts until the spring
 * settles. So every spring runs on the compositor (CSS transitions, keyframes, the Web Animations API),
 * never frame by frame on the main thread, which is busy exactly while agents stream.
 *
 * The three presets are CSS custom properties in kit/tokens.css (`--spring-<name>` and `--spring-<name>-ms`),
 * written from here by `node --experimental-strip-types scripts/springs.ts`; test/spring.test.ts fails when they drift. A motion that
 * starts from a finger (a card let go, a sheet flicked) asks `springWith` for the same spring carrying the
 * finger's speed.
 */

export interface Spring {
  /** Seconds: how long the motion feels (SwiftUI's `duration`); the spring settles a little after. */
  duration: number;
  /** 0 is critically damped (no overshoot); 0.3 is iOS's bouncy. */
  bounce: number;
}

/** Named after SwiftUI's: smooth and snappy as Apple tunes them, bouncy a little tamer (a work tool you watch all day should not wobble). Settled to the eye by ~300 ms. */
export const SPRINGS = {
  /** Sheets, screens, anything large. No overshoot. */
  smooth: { duration: 0.35, bounce: 0 },
  /** Menus, pills, buttons, a card springing back. */
  snappy: { duration: 0.3, bounce: 0.15 },
  /** Small confirmations only: the send button, a badge. */
  bouncy: { duration: 0.4, bounce: 0.25 },
} as const satisfies Record<string, Spring>;

export type SpringName = keyof typeof SPRINGS;

/** Close enough to rest that nothing on screen moves any more (a thousandth of the distance). */
const REST = 0.001;

/**
 * The spring's progress from 0 to 1 at time t (seconds), starting with velocity v0 in distances per second
 * (a finger moving toward the target at the whole distance per second is 1). May pass 1 when it bounces.
 */
export function springAt({ duration, bounce }: Spring, t: number, v0 = 0): number {
  const w0 = (2 * Math.PI) / duration;
  const zeta = 1 - Math.max(0, Math.min(0.99, bounce));
  // Solved for the displacement y = 1 - progress: y(0) = 1, y'(0) = -v0.
  const y0 = 1;
  const dy0 = -v0;
  if (zeta >= 1) return 1 - Math.exp(-w0 * t) * (y0 + (dy0 + w0 * y0) * t);
  const wd = w0 * Math.sqrt(1 - zeta * zeta);
  const decay = Math.exp(-zeta * w0 * t);
  return 1 - decay * (y0 * Math.cos(wd * t) + ((dy0 + zeta * w0 * y0) / wd) * Math.sin(wd * t));
}

/** Seconds until the spring is at rest: past REST of the distance and staying there. */
export function settleTime(spring: Spring, v0 = 0): number {
  const step = 0.004;
  let last = 0;
  for (let t = 0; t < 4; t += step) if (Math.abs(1 - springAt(spring, t, v0)) > REST) last = t;
  return last + step;
}

const round = (n: number) => Number(n.toFixed(4));

/** The spring as a CSS `linear()` easing and the duration it takes, for a transition, a keyframe or el.animate(). */
export function springWith(spring: Spring, v0 = 0): { easing: string; ms: number } {
  const total = settleTime(spring, v0);
  // One point per ~12 ms of motion reads as a curve on any screen; linear() fills between them.
  const n = Math.max(20, Math.min(80, Math.ceil(total / 0.012)));
  const points: number[] = [];
  for (let i = 0; i <= n; i++) points.push(round(i === n ? 1 : springAt(spring, (total * i) / n, v0)));
  return { easing: `linear(${points.join(", ")})`, ms: Math.round(total * 1000) };
}

/** A preset by name, optionally carrying a start velocity; clamped, so a wild flick cannot throw the curve off the screen. */
export function spring(name: SpringName, v0 = 0): { easing: string; ms: number } {
  return springWith(SPRINGS[name], Math.max(-8, Math.min(8, v0)));
}

/** The block kit/tokens.css carries between its spring markers. */
export function springTokens(): string {
  return (Object.keys(SPRINGS) as SpringName[])
    .map((name) => {
      const { easing, ms } = spring(name);
      return `  --spring-${name}: ${easing};\n  --spring-${name}-ms: ${ms}ms;`;
    })
    .join("\n");
}
