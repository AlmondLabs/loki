import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PageOs } from "./env.ts";

const DIST = "https://nodejs.org/dist";

export interface NodeInstaller {
  version: string;
  file: string;
  url: string;
  sums: string;
}

export function pickInstaller(index: unknown, os: PageOs): NodeInstaller | null {
  if (os === "linux" || !Array.isArray(index)) return null;
  for (const entry of index as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const { version, lts, files } = entry as { version?: unknown; lts?: unknown; files?: unknown };
    if (typeof version !== "string" || !lts || !Array.isArray(files)) continue;
    const kind = os === "macos" ? "osx-x64-pkg" : "win-x64-msi";
    if (!files.includes(kind)) continue;
    const file = os === "macos" ? `node-${version}.pkg` : `node-${version}-x64.msi`;
    return { version, file, url: `${DIST}/${version}/${file}`, sums: `${DIST}/${version}/SHASUMS256.txt` };
  }
  return null;
}

export function checksumOf(sums: string, file: string): string | null {
  for (const line of sums.split("\n")) {
    const [hash, name] = line.trim().split(/\s+/);
    if (name === file && hash && /^[0-9a-f]{64}$/.test(hash)) return hash;
  }
  return null;
}

export type InstallOutcome = { kind: "installed" } | { kind: "opened" } | { kind: "cancelled" } | { kind: "failed"; message: string };

export interface NodeInstallHost {
  os: PageOs;
  fetch: (url: string) => Promise<Response>;
  folder: () => Promise<string>;
  write: (file: string, bytes: Uint8Array) => Promise<void>;
  read: (file: string) => Promise<Uint8Array>;
  remove: (folder: string) => Promise<void>;
  run: (command: string, args: string[]) => Promise<number | null>;
  log: (line: string) => void;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function msiOutcome(code: number | null): InstallOutcome {
  if (code === 0 || code === 3010) return { kind: "installed" };
  if (code === 1602) return { kind: "cancelled" };
  return { kind: "failed", message: `the Node installer stopped (${code ?? "no exit code"})` };
}

async function download(h: NodeInstallHost): Promise<{ folder: string; file: string; installer: NodeInstaller } | InstallOutcome> {
  const index: unknown = await (await h.fetch(`${DIST}/index.json`)).json();
  const installer = pickInstaller(index, h.os);
  if (!installer) return { kind: "failed", message: "nodejs.org lists no installer for this system" };
  const expected = checksumOf(await (await h.fetch(installer.sums)).text(), installer.file);
  if (!expected) return { kind: "failed", message: `nodejs.org lists no checksum for ${installer.file}` };
  const response = await h.fetch(installer.url);
  if (!response.ok) return { kind: "failed", message: `nodejs.org answered ${response.status} for ${installer.file}` };
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (sha256(bytes) !== expected) return { kind: "failed", message: `${installer.file} did not match nodejs.org's checksum` };
  const folder = await h.folder();
  const file = join(folder, installer.file);
  await h.write(file, bytes);
  return { folder, file, installer };
}

/** Download the current LTS installer from nodejs.org, check it against the release's SHA-256 list, check it again just before it opens, and open it. */
export async function installNode(h: NodeInstallHost): Promise<InstallOutcome> {
  let folder: string | null = null;
  try {
    const got = await download(h);
    if ("kind" in got) return got;
    folder = got.folder;
    const expected = checksumOf(await (await h.fetch(got.installer.sums)).text(), got.installer.file);
    if (!expected || sha256(await h.read(got.file)) !== expected) return { kind: "failed", message: `${got.installer.file} changed before it opened` };
    h.log(`opening the Node ${got.installer.version} installer`);
    if (h.os === "macos") {
      const code = await h.run("open", ["-W", got.file]);
      return code === 0 ? { kind: "opened" } : { kind: "failed", message: `the Node installer did not open (${code ?? "no exit code"})` };
    }
    return msiOutcome(await h.run("msiexec", ["/i", got.file]));
  } catch (error) {
    return { kind: "failed", message: `loki could not get Node: ${String(error)}` };
  } finally {
    if (folder) await h.remove(folder).catch(() => {});
  }
}

export function machineNodeInstallHost(os: PageOs, log: (line: string) => void): NodeInstallHost {
  return {
    os,
    fetch: (url) => fetch(url, { signal: AbortSignal.timeout(10 * 60_000) }),
    folder: () => mkdtemp(join(tmpdir(), "loki-node-")),
    write: (file, bytes) => writeFile(file, bytes, { mode: 0o600 }),
    read: (file) => readFile(file),
    remove: (folder) => rm(folder, { recursive: true, force: true }),
    run: (command, args) =>
      new Promise((resolve) => {
        const child = spawn(command, args, { stdio: "ignore", windowsHide: false });
        child.once("error", () => resolve(null));
        child.once("exit", (code) => resolve(code));
      }),
    log,
  };
}

export class NodeInstalls {
  private running: Promise<InstallOutcome> | null = null;
  private readonly host: NodeInstallHost;

  constructor(host: NodeInstallHost) {
    this.host = host;
  }

  install(): Promise<InstallOutcome> {
    this.running ??= installNode(this.host).finally(() => {
      this.running = null;
    });
    return this.running;
  }
}
