import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";

/**
 * The file this code runs from: mod/paths.ts in a checkout, or the bundled
 * <data>/daemon/daemon.mjs the app installed. import.meta.url may carry ?v=; fileURLToPath ignores it.
 */
export const modFile: string = fileURLToPath(new URL(import.meta.url));

export const projectRoot: string = dirname(dirname(modFile));

export const lokiDir = (): string => process.env.LOKI_DIR ?? join(homedir(), ".loki");

const stateDir = process.env.LOKI_STATE_DIR ?? join(lokiDir(), "state");

export const paths = {
  root: projectRoot,
  app: join(projectRoot, "app"),
  widgets: process.env.LOKI_WIDGETS_DIR ?? join(lokiDir(), "widgets"),
  data: lokiDir(),
  uploads: process.env.LOKI_UPLOADS_DIR ?? join(lokiDir(), "uploads"),
  chatImages: join(lokiDir(), "chat-images"),
  state: stateDir,
  lan: join(stateDir, "lan.json"),
  devices: join(stateDir, "devices.json"),
  peers: join(stateDir, "peers.json"),
  token: join(lokiDir(), "token"),
  modLog: join(lokiDir(), "mod.log"),
} as const;

export function appVersion(root: string): string | null {
  if (process.env.LOKI_VERSION) return process.env.LOKI_VERSION;
  try {
    const v = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown }).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

export const DEFAULT_MOD_PORT = 41414;
export const MCP_OAUTH_CALLBACK = "/mcp/oauth/callback";
export const DEFAULT_LAN_PORT = 41415;

const installedBundle = basename(modFile) === "daemon.mjs";
export const appDistCandidates: string[] = [
  ...(process.env.LOKI_APP_DIST ? [process.env.LOKI_APP_DIST] : []),
  ...(installedBundle ? [join(dirname(modFile), "..", "app")] : []),
  join(projectRoot, "app", "dist"),
];
