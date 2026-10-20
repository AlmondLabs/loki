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

/** Everything loki keeps: ~/.loki (LOKI_DIR overrides it, for tests and a second loki). */
export const lokiDir = (): string => process.env.LOKI_DIR ?? join(homedir(), ".loki");

const stateDir = process.env.LOKI_STATE_DIR ?? join(lokiDir(), "state");

/** Every file and folder the mod reads or writes; each LOKI_*_DIR variable moves its folder elsewhere (tests do). */
export const paths = {
  root: projectRoot,
  app: join(projectRoot, "app"),
  /** Agent-owned widget files: <widgets>/<scope>/<name>.json|.tsx — user data, outside the repo. */
  widgets: process.env.LOKI_WIDGETS_DIR ?? join(lokiDir(), "widgets"),
  /** Machine-local runtime data. */
  data: lokiDir(),
  /** Files attached to messages (mod/uploads.ts): <uploads>/<chat>/<name>, read by the agent from there. */
  uploads: process.env.LOKI_UPLOADS_DIR ?? join(lokiDir(), "uploads"),
  /** The pictures in the person's messages, as the daemon writes them (daemon/chat-images.ts, plan 029). */
  chatImages: join(lokiDir(), "chat-images"),
  state: stateDir,
  /** The phone listener's setting ({ enabled }) and its paired devices (mod/lan.ts, mod/devices.ts). */
  lan: join(stateDir, "lan.json"),
  devices: join(stateDir, "devices.json"),
  /** The Macs paired with this one (mod/peers.ts): their hello and the hash of the token each presents. */
  peers: join(stateDir, "peers.json"),
  token: join(lokiDir(), "token"),
  modLog: join(lokiDir(), "mod.log"),
  /** Product analytics (core/analytics.ts): one event per line, local only; and the install's distinct_id. */
  events: join(lokiDir(), "logs", "events.jsonl"),
  analytics: join(stateDir, "analytics.json"),
} as const;

/**
 * The desk server's port, on 127.0.0.1 only (LOKI_PORT overrides it). Its routes need the desktop token, apart from
 * /health and the MCP sign-in callback.
 */
export const DEFAULT_MOD_PORT = 41414;
/** Where a browser comes back after signing in to a remote MCP server (daemon/mcp/oauth.ts), on the loopback server only. */
export const MCP_OAUTH_CALLBACK = "/mcp/oauth/callback";
/** The LAN listener for phones (mod/lan.ts): a second port, never the first. */
export const DEFAULT_LAN_PORT = 41415;

// Only the installed bundle (<data>/mod/loki-mod.mjs) has an app/ beside it; the dev bundle boot.ts writes
// (.loki-build/mod-<ts>.mjs) sits next to the *source* app/, which must not be served.
const installedBundle = basename(modFile) === "loki-mod.mjs";
/**
 * Where the built canvas may be, in order: LOKI_APP_DIST, the installed layout
 * (<data>/app beside <data>/mod/loki-mod.mjs), then a checkout's app/dist.
 * mod/static.ts takes the first that has an index.html and assets/. In a checkout `<mod dir>/../app`
 * is the app's *source* directory, whose index.html loads /src/main.tsx: skipped.
 */
export const appDistCandidates: string[] = [
  ...(process.env.LOKI_APP_DIST ? [process.env.LOKI_APP_DIST] : []),
  ...(installedBundle ? [join(dirname(modFile), "..", "app")] : []),
  join(projectRoot, "app", "dist"),
];
