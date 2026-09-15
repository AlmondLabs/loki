/**
 * Letta Code's mod API and app-server protocol are not versioned for third parties; loki hand-types both.
 * loki runs the Letta Code installed on the Mac (npm's newest at first launch, then whatever the user's
 * terminal sessions update it to), so there is a range rather than a pin: below MIN loki refuses plainly
 * and names the upgrade command; up to TESTED it is the exercised path; above TESTED it runs, and Settings
 * says "newer than tested" so a breakage has a first suspect.
 *
 * An app-server answers app_server_info.letta_code_version with its own version, but some builds have
 * carried a stale string (the 0.31.12 release said 0.30.27), so a second accepted report exists for the
 * tested build.
 */
export const MIN_LETTA_CODE = "0.31.12";
/** The newest release loki was exercised against (docs/RELEASING.md: retest and move this on each release). */
export const TESTED_LETTA_CODE = "0.32.10";
/** What that release's app-server answers in app_server_info.letta_code_version. */
export const TESTED_APP_SERVER_REPORT = "0.32.10";

/** -1, 0, 1 across dotted numbers; a missing part counts as 0 ("0.32" == "0.32.0"). Non-numeric parts compare as 0. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.trim().replace(/^v/, "").split(/[\s(]/)[0].split(".").map((p) => Number.parseInt(p, 10) || 0);
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export type Standing = "tested" | "newer" | "older" | "too_old";

/**
 * Where a reported Letta Code version stands against the range: the tested release (or its app-server's own
 * report of itself), newer than it, older but at or above the minimum, or below the minimum. null: nothing reported.
 */
export function lettaStanding(reported: string | null | undefined): Standing | null {
  if (!reported) return null;
  if (compareVersions(reported, TESTED_APP_SERVER_REPORT) === 0 || compareVersions(reported, TESTED_LETTA_CODE) === 0) return "tested";
  if (compareVersions(reported, MIN_LETTA_CODE) < 0) return "too_old";
  return compareVersions(reported, TESTED_LETTA_CODE) > 0 ? "newer" : "older";
}

/** The one line for a version below the minimum. */
export const UPGRADE_LINE = "npm install -g @letta-ai/letta-code@latest";
