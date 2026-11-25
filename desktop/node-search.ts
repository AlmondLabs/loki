import { execFile } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { PageOs } from "./env.ts";

export type Version = readonly [number, number, number];

export const NODE_MIN: Version = [22, 19, 0];

export function parseVersion(text: string): Version | null {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(text.trim().replace(/^v/, ""));
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match.at(3) ?? 0)];
}

export function compareVersions(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export const versionText = (v: Version): string => v.join(".");

export interface NodeHost {
  os: PageOs;
  home: string;
  root: string;
  path: string | undefined;
  env: Record<string, string | undefined>;
  version: (bin: string) => Promise<Version | null>;
  isFile: (path: string) => boolean;
  list: (dir: string) => string[];
}

export type NodeSearch = { found: true; node: string; dir: string; version: Version } | { found: false; old: { version: Version; at: string } | null };

const pathFor = (os: PageOs) => (os === "windows" ? win32 : posix);
const programNames = (os: PageOs, program: string): string[] => (os === "windows" ? [`${program}.exe`] : [program]);
const scriptNames = (os: PageOs, program: string): string[] => (os === "windows" ? [`${program}.cmd`, `${program}.exe`] : [program]);

function newestVersioned(h: NodeHost, dir: string, binOf: (versionDir: string) => string): string | null {
  const p = pathFor(h.os);
  let best: { v: Version; dir: string } | null = null;
  for (const name of h.list(dir)) {
    const v = parseVersion(name);
    if (!v) continue;
    const bin = binOf(p.join(dir, name));
    if (!programNames(h.os, "node").some((n) => h.isFile(p.join(bin, n)))) continue;
    if (!best || compareVersions(v, best.v) > 0) best = { v, dir: bin };
  }
  return best?.dir ?? null;
}

/**
 * Where installers put Node, beyond PATH, in the order the Tauri shell looked: a GUI app's PATH is
 * `/usr/bin:/bin:/usr/sbin:/sbin`, so without this list a Homebrew or nvm `node` would never be found.
 */
export function binDirs(h: NodeHost): string[] {
  const p = pathFor(h.os);
  const env = (key: string) => h.env[key] || null;
  const dirs: string[] = (h.path ?? "").split(h.os === "windows" ? ";" : ":");
  if (h.os === "windows") {
    const roaming = env("APPDATA") ?? p.join(h.home, "AppData", "Roaming");
    const local = env("LOCALAPPDATA") ?? p.join(h.home, "AppData", "Local");
    dirs.push(p.join(roaming, "npm"));
    const programFiles = env("ProgramFiles");
    if (programFiles) dirs.push(p.join(programFiles, "nodejs"));
    dirs.push(p.join(local, "Volta", "bin"));
    const symlink = env("NVM_SYMLINK");
    if (symlink) dirs.push(symlink);
    const nvm = newestVersioned(h, env("NVM_HOME") ?? p.join(roaming, "nvm"), (d) => d);
    if (nvm) dirs.push(nvm);
    for (const f of [env("FNM_DIR"), p.join(roaming, "fnm"), p.join(local, "fnm")]) if (f) dirs.push(p.join(f, "aliases", "default"));
    const scoop = env("SCOOP") ?? p.join(h.home, "scoop");
    dirs.push(p.join(scoop, "shims"));
    for (const app of ["nodejs", "nodejs-lts"]) dirs.push(p.join(scoop, "apps", app, "current"), p.join(scoop, "persist", app, "bin"));
    dirs.push(p.join(h.home, ".bun", "bin"));
  } else {
    const system = h.os === "macos" ? ["opt/homebrew/bin", "usr/local/bin"] : ["usr/local/bin", "usr/bin", "home/linuxbrew/.linuxbrew/bin"];
    dirs.push(...system.map((d) => p.join(h.root, d)));
    for (const d of [".volta/bin", ".bun/bin", ".npm-global/bin", ".local/bin"]) dirs.push(p.join(h.home, d));
    const nvm = newestVersioned(h, p.join(h.home, ".nvm", "versions", "node"), (d) => p.join(d, "bin"));
    if (nvm) dirs.push(nvm);
    const fnm = [p.join(h.home, ".local", "share", "fnm"), p.join(h.home, ".fnm")];
    if (h.os === "macos") fnm.unshift(p.join(h.home, "Library", "Application Support", "fnm"));
    for (const f of fnm) dirs.push(p.join(f, "aliases", "default", "bin"));
  }
  return [...new Set(dirs.filter((d) => d !== ""))];
}

/**
 * The machine's Node for the daemon and its agents: `LOKI_NODE_BIN` when it is new enough, else the newest Node at or
 * above `NODE_MIN` with `npx` beside it. The Node a Tauri loki downloaded into `~/.loki/runtime` never counts. A
 * miss names the newest Node that was too old, if any.
 */
export async function findNode(h: NodeHost): Promise<NodeSearch> {
  const p = pathFor(h.os);
  const runtime = p.join(h.home, ".loki", "runtime");
  const inRuntime = (file: string) => {
    const rel = p.relative(runtime, file);
    return rel !== "" && !rel.startsWith("..") && !p.isAbsolute(rel);
  };
  const chosen = h.env.LOKI_NODE_BIN;
  if (chosen && h.isFile(chosen)) {
    const v = await h.version(chosen);
    if (v && compareVersions(v, NODE_MIN) >= 0) return { found: true, node: chosen, dir: p.dirname(chosen), version: v };
  }
  const candidates = binDirs(h)
    .flatMap((d) => programNames(h.os, "node").map((n) => p.join(d, n)))
    .filter((file) => !inRuntime(file) && h.isFile(file));
  const versions = await Promise.all(candidates.map(async (file) => ({ file, v: await h.version(file) })));
  let best: { file: string; v: Version } | null = null;
  let old: { version: Version; at: string } | null = null;
  for (const { file, v } of versions) {
    if (!v) continue;
    if (compareVersions(v, NODE_MIN) < 0) {
      if (!old || compareVersions(v, old.version) > 0) old = { version: v, at: file };
      continue;
    }
    const npx = scriptNames(h.os, "npx").some((n) => h.isFile(p.join(p.dirname(file), n)));
    if (npx && (!best || compareVersions(v, best.v) > 0)) best = { file, v };
  }
  return best ? { found: true, node: best.file, dir: p.dirname(best.file), version: best.v } : { found: false, old };
}

export function nodeVersion(bin: string): Promise<Version | null> {
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { timeout: 10_000, windowsHide: true }, (error, stdout) => resolve(error ? null : parseVersion(stdout)));
  });
}

export function machineNodeHost(os: PageOs, home: string, env: NodeJS.ProcessEnv): NodeHost {
  return {
    os,
    home,
    root: os === "windows" ? "" : "/",
    path: env.PATH ?? env.Path,
    env,
    version: nodeVersion,
    isFile: (file) => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    },
    list: (dir) => {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    },
  };
}
