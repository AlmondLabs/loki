import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { join, posix, win32 } from "node:path";
import { messageOf } from "../core/errors.ts";
import type { PageOs } from "./env.ts";
import runtimeJson from "./runtime.json" with { type: "json" };

export interface Archive {
  url: string;
  sha256: string;
}

export interface GitManifest {
  version: string;
  targets: Partial<Record<string, Archive>>;
}

export interface Preparing {
  name: "git";
  version: string;
  done: number;
  total: number | null;
}

export type Fetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>;
export type Extract = (archive: string, into: string) => Promise<void>;

export interface GitHost {
  root: string;
  target: string;
  manifest: GitManifest;
  fetch: Fetch;
  extract: Extract;
  stallMs?: number;
}

export interface ToolsHost {
  os: PageOs;
  path: string | undefined;
  env: Record<string, string | undefined>;
  isFile: (path: string) => boolean;
}

export const GIT_TARGET = "win-x64";
const STALL_MS = 30_000;
const SELF_EXTRACTING = ".7z.exe";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseGitManifest(data: unknown): GitManifest {
  const git = isRecord(data) ? data.git : undefined;
  if (!isRecord(git) || typeof git.version !== "string" || !isRecord(git.targets)) throw new Error("runtime.json names no git");
  const targets: Partial<Record<string, Archive>> = {};
  for (const [target, archive] of Object.entries(git.targets)) {
    if (isRecord(archive) && typeof archive.url === "string" && typeof archive.sha256 === "string")
      targets[target] = { url: archive.url, sha256: archive.sha256 };
  }
  return { version: git.version, targets };
}

export const gitManifest = (): GitManifest => parseGitManifest(runtimeJson);

export const gitFolder = (version: string, target: string): string => `git-${version}-${target}`;

const gitProgram = join("cmd", "git.exe");

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

async function fetchChecked(h: GitHost, archive: Archive, fileName: string, to: string, progress: (p: Preparing) => void): Promise<void> {
  const version = h.manifest.version;
  const failed = (error: unknown) => new Error(`could not download ${fileName}: ${messageOf(error)}`, { cause: error });
  progress({ name: "git", version, done: 0, total: null });
  const abort = new AbortController();
  let stall: ReturnType<typeof setTimeout> | undefined;
  const watch = () => {
    clearTimeout(stall);
    stall = setTimeout(() => abort.abort(new Error("the download stalled")), h.stallMs ?? STALL_MS);
  };
  watch();
  const handle = await open(to, "w");
  try {
    let response: Response;
    try {
      response = await h.fetch(archive.url, { signal: abort.signal });
    } catch (error) {
      throw failed(error);
    }
    if (!response.ok || !response.body) throw failed(new Error(`the server answered ${response.status}`));
    const length = Number(response.headers.get("content-length"));
    const total = Number.isInteger(length) && length > 0 ? length : null;
    const hash = createHash("sha256");
    let done = 0;
    progress({ name: "git", version, done, total });
    const reader = response.body.getReader();
    for (;;) {
      watch();
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        throw failed(error);
      }
      if (chunk.done) break;
      hash.update(chunk.value);
      await handle.write(chunk.value);
      done += chunk.value.byteLength;
      progress({ name: "git", version, done, total });
    }
    if (hash.digest("hex") !== archive.sha256.trim().toLowerCase())
      throw new Error(`${fileName} does not match its published checksum, so loki did not use it`);
  } finally {
    clearTimeout(stall);
    await handle.close();
  }
}

async function unpack(h: GitHost, fileName: string, file: string, into: string): Promise<string> {
  mkdirSync(into, { recursive: true });
  try {
    await h.extract(file, into);
  } catch (error) {
    throw new Error(`could not unpack ${fileName}: ${messageOf(error)}`, { cause: error });
  }
  const entries = readdirSync(into, { withFileTypes: true });
  const only = entries.length === 1 ? entries.at(0) : undefined;
  return only?.isDirectory() ? join(into, only.name) : into;
}

export async function ensurePortableGit(h: GitHost, progress: (p: Preparing) => void): Promise<string[]> {
  const base = gitFolder(h.manifest.version, h.target);
  const dir = join(h.root, base);
  const path = [join(dir, "cmd"), join(dir, "bin")];
  if (isFile(join(dir, gitProgram))) return path;
  const archive = h.manifest.targets[h.target];
  if (!archive) throw new Error(`runtime.json names no git for ${h.target}`);
  const fileName = archive.url.split("/").pop() ?? archive.url;
  if (!fileName.endsWith(SELF_EXTRACTING)) throw new Error(`loki cannot unpack ${fileName}`);
  try {
    mkdirSync(h.root, { recursive: true });
  } catch (error) {
    throw new Error(`could not make ${h.root}: ${messageOf(error)}`, { cause: error });
  }
  const download = join(h.root, `.${base}${SELF_EXTRACTING}`);
  const unpacking = join(h.root, `.${base}.unpack`);
  const clean = () => {
    rmSync(download, { force: true });
    rmSync(unpacking, { recursive: true, force: true });
  };
  clean();
  rmSync(dir, { recursive: true, force: true });
  try {
    await fetchChecked(h, archive, fileName, download, progress);
    const top = await unpack(h, fileName, download, unpacking);
    if (!isFile(join(top, gitProgram))) throw new Error(`${fileName} holds no ${gitProgram}`);
    try {
      renameSync(top, dir);
    } catch (error) {
      throw new Error(`could not move git into ${dir}: ${messageOf(error)}`, { cause: error });
    }
  } finally {
    clean();
  }
  return path;
}

export function prunePortableGit(h: Pick<GitHost, "root" | "manifest" | "target">, warn: (line: string) => void = () => {}): void {
  const keep = gitFolder(h.manifest.version, h.target);
  let entries;
  try {
    entries = readdirSync(h.root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.name.startsWith("git-") || e.name === keep || !e.isDirectory()) continue;
    try {
      rmSync(join(h.root, e.name), { recursive: true, force: true });
    } catch (error) {
      warn(`runtime: could not remove ${join(h.root, e.name)}: ${messageOf(error)}`);
    }
  }
}

const pathFor = (os: PageOs) => (os === "windows" ? win32 : posix);

const pathDirs = (h: ToolsHost) => (h.path ?? "").split(h.os === "windows" ? ";" : ":").filter((d) => d !== "");

const onPath = (h: ToolsHost, program: string) => pathDirs(h).some((d) => h.isFile(pathFor(h.os).join(d, h.os === "windows" ? `${program}.exe` : program)));

export function gitMissing(h: ToolsHost): boolean {
  if (h.os !== "windows") return false;
  const p = pathFor(h.os);
  const gitBash = ["ProgramFiles", "ProgramFiles(x86)"].map((k) => h.env[k]).some((root) => !!root && h.isFile(p.join(root, "Git", "bin", "bash.exe")));
  return !(onPath(h, "git") && (gitBash || onPath(h, "bash")));
}

export async function toolsMissing(h: ToolsHost, developerDir: () => Promise<string | null>): Promise<"macos" | "linux" | null> {
  if (h.os === "macos") {
    const dir = await developerDir();
    return dir && h.isFile(posix.join(dir, "usr", "bin", "git")) ? null : "macos";
  }
  if (h.os === "linux") return onPath(h, "git") ? null : "linux";
  return null;
}

export function developerDir(platform: NodeJS.Platform = process.platform): Promise<string | null> {
  if (platform !== "darwin") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("/usr/bin/xcode-select", ["-p"], { timeout: 10_000 }, (error, stdout) => {
      const dir = stdout.trim();
      resolve(error || dir === "" ? null : dir);
    });
  });
}

export function installTools(platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform !== "darwin") return Promise.reject(new Error("only the Mac installs its command line tools from loki"));
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/xcode-select", ["--install"], (error, _stdout, stderr) => {
      if (!error) return resolve();
      const said = stderr.trim();
      reject(new Error(said || `could not run xcode-select: ${error.message}`));
    });
  });
}

export function runSelfExtracting(archive: string, into: string): Promise<void> {
  const shown = win32.basename(archive);
  return new Promise((resolve, reject) => {
    execFile(archive, ["-y", `-o${into}`], { windowsHide: true }, (error) =>
      error ? reject(new Error(`${shown} could not unpack itself (${error.message})`, { cause: error })) : resolve(),
    );
  });
}
