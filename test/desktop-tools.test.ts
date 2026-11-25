import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { PageOs } from "../desktop/env.ts";
import {
  ensurePortableGit,
  gitManifest,
  gitMissing,
  prunePortableGit,
  toolsMissing,
  type Extract,
  type GitHost,
  type Preparing,
  type ToolsHost,
} from "../desktop/tools.ts";

const temps: string[] = [];
const tempRoot = () => {
  const dir = mkdtempSync(join(tmpdir(), "loki-tools-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const GIT_URL = "https://example.test/PortableGit-2.56.1-64-bit.7z.exe";
const BODY = Buffer.from("a self-extracting PortableGit");
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const names = (root: string) => (existsSync(root) ? readdirSync(root).sort() : []);

function body(bytes: Buffer, cutAfter?: number): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes.subarray(0, cutAfter ?? bytes.length)));
      if (cutAfter === undefined) controller.close();
      else controller.error(new Error("connection reset"));
    },
  });
}

function gitHost(root: string, opts: { sha?: string; cutAfter?: number; fetchError?: string } = {}) {
  const seen = { fetches: 0, extracts: 0 };
  const extract: Extract = (_archive, into) => {
    seen.extracts++;
    for (const file of [join("PortableGit", "cmd", "git.exe"), join("PortableGit", "bin", "bash.exe")]) {
      mkdirSync(join(into, file, ".."), { recursive: true });
      writeFileSync(join(into, file), "");
    }
    return Promise.resolve();
  };
  const host: GitHost = {
    root,
    target: "win-x64",
    manifest: { version: "2.56.1", targets: { "win-x64": { url: GIT_URL, sha256: opts.sha ?? sha256(BODY) } } },
    fetch: (url) => {
      seen.fetches++;
      if (opts.fetchError) return Promise.reject(new Error(opts.fetchError));
      if (url !== GIT_URL) return Promise.resolve(new Response("missing", { status: 404 }));
      return Promise.resolve(new Response(body(BODY, opts.cutAfter), { headers: { "content-length": String(BODY.length) } }));
    },
    extract,
  };
  return { host, seen };
}

describe("PortableGit", () => {
  test("Windows without Git Bash fetches it, checks its hash and unpacks it into its own folder", async () => {
    const root = tempRoot();
    const { host, seen } = gitHost(root);
    const progress: Preparing[] = [];
    const path = await ensurePortableGit(host, (p) => progress.push(p));
    const dir = join(root, "git-2.56.1-win-x64");
    expect(path).toEqual([join(dir, "cmd"), join(dir, "bin")]);
    expect(existsSync(join(dir, "cmd", "git.exe"))).toBe(true);
    expect(names(root)).toEqual(["git-2.56.1-win-x64"]);
    expect(progress[0]).toEqual({ name: "git", version: "2.56.1", done: 0, total: null });
    expect(progress[1]).toEqual({ name: "git", version: "2.56.1", done: 0, total: BODY.length });
    expect(progress.at(-1)).toEqual({ name: "git", version: "2.56.1", done: BODY.length, total: BODY.length });
    expect(seen).toEqual({ fetches: 1, extracts: 1 });
    expect(await ensurePortableGit(host, () => {})).toEqual(path);
    expect(seen.fetches).toBe(1);
  });

  test("a hash mismatch leaves nothing at the final path, runs nothing, and names the archive", async () => {
    const root = tempRoot();
    const { host, seen } = gitHost(root, { sha: sha256(Buffer.from("something else")) });
    const failed = ensurePortableGit(host, () => {});
    await expect(failed).rejects.toThrow(/PortableGit-2\.56\.1-64-bit\.7z\.exe does not match its published checksum/);
    expect(names(root)).toEqual([]);
    expect(seen.extracts).toBe(0);
  });

  test("a download cut off partway leaves nothing, and the next attempt starts clean", async () => {
    const root = tempRoot();
    await expect(ensurePortableGit(gitHost(root, { cutAfter: 5 }).host, () => {})).rejects.toThrow(/could not download PortableGit-2\.56\.1-64-bit\.7z\.exe/);
    expect(names(root)).toEqual([]);
    const progress: Preparing[] = [];
    await expect(ensurePortableGit(gitHost(root, { fetchError: "connection refused" }).host, (p) => progress.push(p))).rejects.toThrow(/connection refused/);
    expect(progress).toEqual([{ name: "git", version: "2.56.1", done: 0, total: null }]);
    mkdirSync(join(root, ".git-2.56.1-win-x64.unpack", "junk"), { recursive: true });
    await ensurePortableGit(gitHost(root).host, () => {});
    expect(names(root)).toEqual(["git-2.56.1-win-x64"]);
    expect(existsSync(join(root, "git-2.56.1-win-x64", "junk"))).toBe(false);
  });

  test("pruning after a start removes other versions and keeps the one in use", async () => {
    const root = tempRoot();
    const { host } = gitHost(root);
    await ensurePortableGit(host, () => {});
    for (const old of ["git-2.50.0-win-x64", "node-22.19.0-win-x64", "elsewhere"]) mkdirSync(join(root, old, "bin"), { recursive: true });
    prunePortableGit(host);
    expect(names(root)).toEqual(["elsewhere", "git-2.56.1-win-x64", "node-22.19.0-win-x64"]);
  });

  test("the shipped manifest names a checked PortableGit for Windows and nothing about Node", () => {
    const m = gitManifest();
    const git = m.targets["win-x64"];
    expect(git?.url.startsWith("https://github.com/git-for-windows/git/releases/download/")).toBe(true);
    expect(git?.url.endsWith(`PortableGit-${m.version}-64-bit.7z.exe`)).toBe(true);
    expect(git?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

function toolsHost(os: PageOs, path: string, files: string[], env: Record<string, string> = {}): ToolsHost {
  const set = new Set(files);
  return { os, path, env, isFile: (f) => set.has(f) };
}

describe("git for the agents", () => {
  test("on Windows PortableGit is fetched only when git or Git Bash is missing", () => {
    const tools = "C:\\tools";
    const pf = "C:\\Program Files";
    const env = { ProgramFiles: pf };
    const at = (...parts: string[]) => win32.join(...parts);
    expect(gitMissing(toolsHost("windows", `${tools};`, [], env))).toBe(true);
    expect(gitMissing(toolsHost("windows", `${tools};`, [at(tools, "git.exe")], env))).toBe(true);
    expect(gitMissing(toolsHost("windows", `${tools};`, [at(tools, "git.exe"), at(pf, "Git", "bin", "bash.exe")], env))).toBe(false);
    expect(gitMissing(toolsHost("windows", `${tools};`, [at(tools, "git.exe"), at(tools, "bash.exe")], env))).toBe(false);
    expect(gitMissing(toolsHost("windows", `${tools};`, [at(tools, "bash.exe")], env))).toBe(true);
    expect(
      gitMissing(
        toolsHost("windows", `${tools};`, [at(tools, "git.exe"), at("C:\\Program Files (x86)", "Git", "bin", "bash.exe")], {
          "ProgramFiles(x86)": "C:\\Program Files (x86)",
        }),
      ),
    ).toBe(false);
    expect(gitMissing(toolsHost("macos", "/usr/bin", []))).toBe(false);
  });

  test("is missing on the Mac without the command line tools and on Linux without git on PATH", async () => {
    const clt = "/Library/Developer/CommandLineTools";
    let asked = 0;
    const developerDir = (dir: string | null) => () => {
      asked++;
      return Promise.resolve(dir);
    };
    const mac = (files: string[]) => toolsHost("macos", "/usr/bin:/bin", files);
    expect(await toolsMissing(mac([]), developerDir(null))).toBe("macos");
    expect(await toolsMissing(mac([]), developerDir(clt))).toBe("macos");
    expect(await toolsMissing(mac([posix.join(clt, "usr", "bin", "git")]), developerDir(clt))).toBeNull();
    expect(await toolsMissing(mac(["/usr/bin/git"]), developerDir(null))).toBe("macos");
    expect(asked).toBe(4);
    expect(await toolsMissing(toolsHost("linux", "/home/x/bin:/usr/bin", ["/usr/bin/git"]), developerDir(null))).toBeNull();
    expect(await toolsMissing(toolsHost("linux", "/home/x/bin:/usr/bin", []), developerDir(null))).toBe("linux");
    expect(await toolsMissing(toolsHost("windows", "C:\\x", []), developerDir(null))).toBeNull();
    expect(asked).toBe(4);
  });
});
