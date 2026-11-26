import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { messageOf } from "../core/errors.ts";

/**
 * The built page in a checkout (plan 041): `bun run start` serves `app/dist`, and **update** rebuilds it. A build lands whole:
 * Vite writes to `app/.dist-next`, which then takes `app/dist`'s place, because the window reloads as soon as
 * `app/dist` takes its new build's place (desktop/page-reload.ts) and Vite empties its folder before writing.
 */

export type Runner = (cmd: string, args: string[], cwd: string) => Promise<{ code: number; output: string }>;

export const runFile: Runner = (cmd, args, cwd) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, output: `${stdout}${stderr}` }),
    );
  });

const BUILT = new Set(["dist", ".dist-next", ".dist-old"]);

export function isPageSource(file: string): boolean {
  const parts = file.split(/[\\/]/);
  const top = parts[0] ?? "";
  return !BUILT.has(top) && top !== "node_modules" && !(parts.at(-1) ?? "").startsWith(".");
}

function hasNewer(dir: string, skip: (rel: string) => boolean, built: number, rel = ""): boolean {
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const path = rel ? join(rel, entry.name) : entry.name;
    if (skip(path)) continue;
    if (entry.isDirectory() ? hasNewer(dir, skip, built, path) : statSync(join(dir, path)).mtimeMs > built) return true;
  }
  return false;
}

export function pageStale(checkout: string): boolean {
  const index = join(checkout, "app", "dist", "index.html");
  if (!existsSync(index)) return true;
  const built = statSync(index).mtimeMs;
  return hasNewer(join(checkout, "app"), (p) => !isPageSource(p), built) || hasNewer(join(checkout, "core"), () => false, built);
}

function tail(output: string, lines = 6): string {
  return output.trim().split("\n").slice(-lines).join("\n");
}

export async function buildPage(checkout: string, run: Runner = runFile, node: string = process.execPath): Promise<string | null> {
  const app = join(checkout, "app");
  const next = join(app, ".dist-next");
  const dist = join(app, "dist");
  const old = join(app, ".dist-old");
  await rm(next, { recursive: true, force: true });
  const vite = join(checkout, "node_modules", "vite", "bin", "vite.js");
  const args = [vite, "build", "--config", join("app", "vite.config.ts"), "--outDir", next, "--emptyOutDir", "--logLevel", "error"];
  const result = await run(node, args, checkout);
  if (result.code !== 0 || !existsSync(join(next, "index.html"))) {
    await rm(next, { recursive: true, force: true });
    return tail(result.output) || `the build exited with ${result.code}`;
  }
  try {
    await rm(old, { recursive: true, force: true });
    if (existsSync(dist)) await rename(dist, old);
    await rename(next, dist);
    await rm(old, { recursive: true, force: true });
    return null;
  } catch (err) {
    return `the build could not replace app/dist: ${messageOf(err)}`;
  }
}
