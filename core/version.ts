/**
 * The three numbers of a version string as loki uses them: a stable "2026.1011.0" (the UTC day, then that day's
 * count; "2026.9.28" before October 2026), a release tag "v2026.1011.0", a nightly "2026.1011.1-nightly.4821".
 * Compared part by part as numbers, so every YYYY.MMDD.N stable is newer than every YYYY.M.D one.
 */
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim().replace(/^v/, ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Which channel a build is on, read off its version: a nightly carries the run that built it. */
export type Channel = "stable" | "nightly";
/** The channel a version string is on: nightly when it carries a `-nightly.` part, stable otherwise. */
export const channelOf = (version: string): Channel => (version.includes("-nightly.") ? "nightly" : "stable");

/**
 * The nightly version inside a release title such as "loki 2026.1011.1-nightly.4821 (a96ee85)", or null. Titles from
 * before nightlies carried a run number ("loki 2026.1011.1-nightly.a96ee85") still read, so a page meeting an older
 * release still finds its version.
 */
export const nightlyVersionIn = (text: string | null | undefined): string | null => text?.match(/\d+\.\d+\.\d+-nightly\.(?:[0-9a-f]{7,40}|\d+)\b/)?.[0] ?? null;

/** The dot-separated identifiers after the `-` of a version, `[]` for a release; build metadata after `+` is ignored. */
const prereleaseOf = (v: string): string[] => {
  const tail = /^\d+\.\d+\.\d+-([^+\s]+)/.exec(v.trim().replace(/^v/, ""))?.[1];
  return tail ? tail.split(".") : [];
};

/** Semver's order of two prerelease identifiers: numbers as numbers, below any word; words in ASCII order. */
const compareIdentifiers = (a: string, b: string): number => {
  const [x, y] = [/^\d+$/.test(a), /^\d+$/.test(b)];
  if (x && y) return Number(a) - Number(b);
  if (x !== y) return x ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
};

/**
 * Semver precedence, the order Tauri's updater applies, so the page, the release script and the updater agree: the
 * three numbers first, then a release above its prereleases (a stable above the nightlies that led up to it), then
 * the prerelease identifiers one by one (a nightly's run number as a number). Negative when `a` comes first, positive
 * when `b` does, 0 when they rank alike; null when either is not a version.
 */
export function compareVersions(a: string, b: string): number | null {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  const [p, q] = [prereleaseOf(a), prereleaseOf(b)];
  if (!p.length || !q.length) return q.length - p.length;
  for (let i = 0; i < Math.min(p.length, q.length); i++) {
    const order = compareIdentifiers(p[i], q[i]);
    if (order !== 0) return order;
  }
  return p.length - q.length;
}

/** True when `candidate` is a release after `current` by semver precedence; false for equal, older, or unparsable input. */
export function isNewerVersion(current: string, candidate: string): boolean {
  return (compareVersions(current, candidate) ?? 0) < 0;
}
