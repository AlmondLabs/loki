export function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim().replace(/^v/, ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export type Channel = "stable" | "nightly";
export const channelOf = (version: string): Channel => (version.includes("-nightly.") ? "nightly" : "stable");

const prereleaseOf = (v: string): string[] => {
  const tail = /^\d+\.\d+\.\d+-([^+\s]+)/.exec(v.trim().replace(/^v/, ""))?.[1];
  return tail ? tail.split(".") : [];
};

const compareIdentifiers = (a: string, b: string): number => {
  const [x, y] = [/^\d+$/.test(a), /^\d+$/.test(b)];
  if (x && y) return Number(a) - Number(b);
  if (x !== y) return x ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
};

/**
 * Semver precedence, the order Tauri's updater applies, so the release script and the updater agree: the
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
