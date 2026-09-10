/**
 * Letta Code's mod API and app-server protocol are not versioned for third parties; loki
 * hand-types both. These are the numbers from the release loki was last exercised against.
 * An app-server answers app_server_info.letta_code_version with its own version (0.31.14 says
 * 0.31.14), but the 0.31.12 release said 0.30.27 — a stale string — so both are accepted.
 */
export const TESTED_LETTA_CODE = "0.31.12";
/** What that release's app-server answers in app_server_info.letta_code_version. */
export const TESTED_APP_SERVER_REPORT = "0.30.27";

/**
 * Same major.minor as the tested release — as it reports itself, or as the tested build's stale string
 * reported it. A patch release is expected to work; a new minor is the first suspect when something is off.
 */
export function lettaCompatible(reported: string | null | undefined, tested: string | string[] = [TESTED_LETTA_CODE, TESTED_APP_SERVER_REPORT]): boolean | null {
  if (!reported) return null;
  const mm = (v: string) => v.trim().replace(/^v/, "").split(".").slice(0, 2).join(".");
  const accepted = Array.isArray(tested) ? tested : [tested];
  return accepted.some((t) => mm(reported) === mm(t));
}
