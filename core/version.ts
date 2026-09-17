/** Version strings as loki uses them: a stable "2026.9.28" (the day it shipped, UTC), a release tag "v2026.9.28", a nightly "2026.9.28-nightly.a96ee85". */
export function parseVersion(v: string): [number, number, number] | null {
  const m = v.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Which channel a build is on, read off its version: a nightly carries the merge it was built from. */
export type Channel = "stable" | "nightly";
export const channelOf = (version: string): Channel => (/-nightly\./.test(version) ? "nightly" : "stable");

/** The nightly version inside a release title such as "loki 2026.9.28-nightly.a96ee85", or null. */
export const nightlyVersionIn = (text: string | null | undefined): string | null => text?.match(/\d+\.\d+\.\d+-nightly\.[0-9a-f]{7,40}/)?.[0] ?? null;

/** True when `candidate` is a release after `current`; false for equal, older, or unparsable input. */
export function isNewerVersion(current: string, candidate: string): boolean {
  const a = parseVersion(current);
  const b = parseVersion(candidate);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return b[i] > a[i];
  return false;
}
