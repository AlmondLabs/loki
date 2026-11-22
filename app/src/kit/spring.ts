export interface Spring {
  duration: number;
  bounce: number;
}

export const SPRINGS = {
  smooth: { duration: 0.35, bounce: 0 },
  snappy: { duration: 0.3, bounce: 0.15 },
  bouncy: { duration: 0.4, bounce: 0.25 },
} as const satisfies Record<string, Spring>;

export type SpringName = keyof typeof SPRINGS;

const REST = 0.001;

export function springAt({ duration, bounce }: Spring, t: number, v0 = 0): number {
  const w0 = (2 * Math.PI) / duration;
  const zeta = 1 - Math.max(0, Math.min(0.99, bounce));
  const y0 = 1;
  const dy0 = -v0;
  if (zeta >= 1) return 1 - Math.exp(-w0 * t) * (y0 + (dy0 + w0 * y0) * t);
  const wd = w0 * Math.sqrt(1 - zeta * zeta);
  const decay = Math.exp(-zeta * w0 * t);
  return 1 - decay * (y0 * Math.cos(wd * t) + ((dy0 + zeta * w0 * y0) / wd) * Math.sin(wd * t));
}

export function settleTime(spring: Spring, v0 = 0): number {
  const step = 0.004;
  let last = 0;
  for (let t = 0; t < 4; t += step) if (Math.abs(1 - springAt(spring, t, v0)) > REST) last = t;
  return last + step;
}

const round = (n: number) => Number(n.toFixed(4));

export function springWith(spring: Spring, v0 = 0): { easing: string; ms: number } {
  const total = settleTime(spring, v0);
  const n = Math.max(20, Math.min(80, Math.ceil(total / 0.012)));
  const points: number[] = [];
  for (let i = 0; i <= n; i++) points.push(round(i === n ? 1 : springAt(spring, (total * i) / n, v0)));
  return { easing: `linear(${points.join(", ")})`, ms: Math.round(total * 1000) };
}

export function spring(name: SpringName, v0 = 0): { easing: string; ms: number } {
  return springWith(SPRINGS[name], Math.max(-8, Math.min(8, v0)));
}

const KEEP_ON_ONE_LINE = "/* prettier-ignore */";

export function springTokens(): string {
  return (Object.keys(SPRINGS) as SpringName[])
    .map((name) => {
      const { easing, ms } = spring(name);
      return `  ${KEEP_ON_ONE_LINE}\n  --spring-${name}: ${easing};\n  --spring-${name}-ms: ${ms}ms;`;
    })
    .join("\n");
}
