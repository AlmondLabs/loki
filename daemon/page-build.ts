import { execFile } from "node:child_process";
import { existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { messageOf } from "../core/errors.ts";

/**
 * The built page in a checkout (plan 041): `npm start` serves `app/dist`, and **update** rebuilds it. A build lands whole:
 * Vite writes to `app/.dist-next`, which then takes `app/dist`'s place, because the window reloads as soon as
 * `app/dist` changes (the Tauri CLI's static server watches it) and Vite empties its folder before writing.
 */

/** A command run to its end: its exit code and everything it printed. */
export type Runner = (cmd: string, args: string[], cwd: string) => Promise<{ code: number; output: string }>;

/** Runs a program with no shell, collecting its output. */
export const runFile: Runner = (cmd, args, cwd) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, output: `${stdout}${stderr}` }),
    );
  });

/** Folders under `app/` that are builds, not sources. */
const BUILT = new Set(["dist", ".dist-next", ".dist-old"]);

/** Whether `file`, relative to `app/`, is a source of the page rather than a build of it or a hidden file (`.DS_Store`, an editor's swap file). */
export function isPageSource(file: string): boolean {
  const parts = file.split(/[\\/]/);
  const top = parts[0] ?? "";
  return !BUILT.has(top) && top !== "node_modules" && !(parts.at(-1) ?? "").startsWith(".");
}

/** The newest change under `dir`, skipping what `skip` names (relative paths); 0 when there is nothing. */
function newest(dir: string, skip: (rel: string) => boolean, rel = ""): number {
  let latest = 0;
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const path = rel ? join(rel, entry.name) : entry.name;
    if (skip(path)) continue;
    latest = Math.max(latest, entry.isDirectory() ? newest(dir, skip, path) : statSync(join(dir, path)).mtimeMs);
  }
  return latest;
}

/** Whether `app/dist` is missing or older than a source of the page (`app/` and `core/`, which the page imports). */
export function pageStale(checkout: string): boolean {
  const index = join(checkout, "app", "dist", "index.html");
  if (!existsSync(index)) return true;
  const built = statSync(index).mtimeMs;
  const sources = Math.max(
    newest(join(checkout, "app"), (p) => !isPageSource(p)),
    newest(join(checkout, "core"), () => false),
  );
  return sources > built;
}

/** The last lines of a build's output: enough to say what failed. */
function tail(output: string, lines = 6): string {
  return output.trim().split("\n").slice(-lines).join("\n");
}

/**
 * Build the checkout's page into `app/dist`, whole. Null once built, else what went wrong; a failed build leaves
 * `app/dist` as it was.
 */
export async function buildPage(checkout: string, run: Runner = runFile, node: string = process.execPath): Promise<string | null> {
  const app = join(checkout, "app");
  const next = join(app, ".dist-next");
  const dist = join(app, "dist");
  const old = join(app, ".dist-old");
  rmSync(next, { recursive: true, force: true });
  const vite = join(checkout, "node_modules", "vite", "bin", "vite.js");
  const args = [vite, "build", "--config", join("app", "vite.config.ts"), "--outDir", next, "--emptyOutDir", "--logLevel", "error"];
  const result = await run(node, args, checkout);
  if (result.code !== 0 || !existsSync(join(next, "index.html"))) {
    rmSync(next, { recursive: true, force: true });
    return tail(result.output) || `the build exited with ${result.code}`;
  }
  try {
    rmSync(old, { recursive: true, force: true });
    if (existsSync(dist)) renameSync(dist, old);
    renameSync(next, dist);
    rmSync(old, { recursive: true, force: true });
    return null;
  } catch (err) {
    return `the build could not replace app/dist: ${messageOf(err)}`;
  }
}
