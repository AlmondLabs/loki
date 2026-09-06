import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** Repo root, derived from this file (mod/paths.ts). import.meta.url may carry ?v=; fileURLToPath ignores it. */
export const projectRoot: string = dirname(dirname(fileURLToPath(new URL(import.meta.url))));

export const paths = {
  root: projectRoot,
  app: join(projectRoot, "app"),
  /** Agent-owned widget files: <widgets>/<scope>/<name>.json|.tsx — user data, outside the repo. */
  widgets: process.env.LOKI_WIDGETS_DIR ?? join(homedir(), ".letta", "loki", "widgets"),
  /** Machine-local runtime data. */
  data: join(homedir(), ".letta", "loki"),
  state: process.env.LOKI_STATE_DIR ?? join(homedir(), ".letta", "loki", "state"),
  token: join(homedir(), ".letta", "loki", "token"),
  modLog: join(homedir(), ".letta", "loki", "mod.log"),
} as const;

export const DEFAULT_MOD_PORT = 41414;
