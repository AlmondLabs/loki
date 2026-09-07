/**
 * Letta Code's mod API and app-server protocol are not versioned for third parties; loki
 * hand-types both. These are the numbers from the release loki was last exercised against.
 * The app-server's `letta_code_version` lags the CLI's own version (0.31.12 reports 0.30.27),
 * so the comparison is against what the harness *reports*, not what `letta --version` prints.
 */
export const TESTED_LETTA_CODE = "0.31.12";
/** What that release's app-server answers in app_server_info.letta_code_version. */
export const TESTED_APP_SERVER_REPORT = "0.30.27";

/** Same major.minor as the tested release's report: a patch release is expected to work. */
export function lettaCompatible(reported: string | null | undefined, tested = TESTED_APP_SERVER_REPORT): boolean | null {
  if (!reported) return null;
  const mm = (v: string) => v.trim().replace(/^v/, "").split(".").slice(0, 2).join(".");
  return mm(reported) === mm(tested);
}
