import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** Repo root, derived from this file (mod/paths.ts). import.meta.url may carry ?v=; fileURLToPath ignores it. */
export const projectRoot: string = dirname(dirname(fileURLToPath(new URL(import.meta.url))));

export const paths = {
  root: projectRoot,
  app: join(projectRoot, "app"),
  /** Agent-owned widget files: <widgets>/<scope>/<name>.json|.tsx — user data, outside the repo. */
  widgets: process.env.LOCI_WIDGETS_DIR ?? join(homedir(), ".letta", "loci", "widgets"),
  viteBin: join(projectRoot, "node_modules", "vite", "bin", "vite.js"),
  viteConfig: join(projectRoot, "app", "vite.config.ts"),
  /** Machine-local runtime data. */
  data: join(homedir(), ".letta", "loci"),
  state: process.env.LOCI_STATE_DIR ?? join(homedir(), ".letta", "loci", "state"),
  token: join(homedir(), ".letta", "loci", "token"),
  viteLog: join(homedir(), ".letta", "loci", "vite.log"),
  modLog: join(homedir(), ".letta", "loci", "mod.log"),
} as const;

export const DEFAULT_MOD_PORT = 41414;
export const DEFAULT_APP_PORT = 5173;
