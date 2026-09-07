import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";

/**
 * The file this code runs from: mod/paths.ts in a checkout, or the bundled
 * <data>/mod/loki-mod.mjs the app installed. import.meta.url may carry ?v=; fileURLToPath ignores it.
 */
export const modFile: string = fileURLToPath(new URL(import.meta.url));

/** Repo root, derived from this file (mod/paths.ts). In the bundle this is <data>, which has no app/ sources; see appDistCandidates. */
export const projectRoot: string = dirname(dirname(modFile));

const stateDir = process.env.LOKI_STATE_DIR ?? join(homedir(), ".letta", "loki", "state");

export const paths = {
  root: projectRoot,
  app: join(projectRoot, "app"),
  /** Agent-owned widget files: <widgets>/<scope>/<name>.json|.tsx — user data, outside the repo. */
  widgets: process.env.LOKI_WIDGETS_DIR ?? join(homedir(), ".letta", "loki", "widgets"),
  /** Machine-local runtime data. */
  data: join(homedir(), ".letta", "loki"),
  state: stateDir,
  /** The phone listener's setting ({ enabled }) and its paired devices (mod/lan.ts, mod/devices.ts). */
  lan: join(stateDir, "lan.json"),
  devices: join(stateDir, "devices.json"),
  token: join(homedir(), ".letta", "loki", "token"),
  modLog: join(homedir(), ".letta", "loki", "mod.log"),
} as const;

export const DEFAULT_MOD_PORT = 41414;
/** The LAN listener for phones (mod/lan.ts): a second port, never the first. */
export const DEFAULT_LAN_PORT = 41415;

/**
 * Where the built canvas may be, in order: LOKI_APP_DIST, the installed layout
 * (<data>/app beside <data>/mod/loki-mod.mjs), then a checkout's app/dist.
 * mod/static.ts takes the first that has an index.html. In a checkout `<mod dir>/../app`
 * is the app's *source* directory, whose index.html loads /src/main.tsx: skipped.
 */
// Only the installed bundle (<data>/mod/loki-mod.mjs) has an app/ beside it; the dev bundle boot.ts writes
// (.loki-build/mod-<ts>.mjs) sits next to the *source* app/, which must not be served.
const installedBundle = basename(modFile) === "loki-mod.mjs";
export const appDistCandidates: string[] = [
  ...(process.env.LOKI_APP_DIST ? [process.env.LOKI_APP_DIST] : []),
  ...(installedBundle ? [join(dirname(modFile), "..", "app")] : []),
  join(projectRoot, "app", "dist"),
];
