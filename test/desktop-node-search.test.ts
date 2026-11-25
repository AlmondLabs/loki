import { posix, win32 } from "node:path";
import { describe, expect, test } from "vitest";
import type { PageOs } from "../desktop/env.ts";
import { binDirs, compareVersions, findNode, NODE_MIN, parseVersion, type NodeHost } from "../desktop/node-search.ts";

function fakeHost(os: PageOs, opts: { home?: string; path?: string; env?: Record<string, string>; files?: Record<string, string> } = {}) {
  const p = os === "windows" ? win32 : posix;
  const home = opts.home ?? (os === "windows" ? "C:\\Users\\someone" : os === "macos" ? "/Users/someone" : "/home/someone");
  const files = new Map<string, string>(Object.entries(opts.files ?? {}));
  const host: NodeHost = {
    os,
    home,
    root: os === "windows" ? "" : "/",
    path: opts.path,
    env: opts.env ?? {},
    version: (bin) => Promise.resolve(parseVersion(files.get(bin) ?? "")),
    isFile: (file) => files.has(file),
    list: (dir) => {
      const prefix = dir.endsWith(p.sep) ? dir : dir + p.sep;
      return [...new Set([...files.keys()].filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length).split(p.sep)[0] ?? ""))];
    },
  };
  const node = (dir: string, version: string, npx = true) => {
    files.set(p.join(dir, os === "windows" ? "node.exe" : "node"), version);
    if (npx) files.set(p.join(dir, os === "windows" ? "npx.cmd" : "npx"), "");
  };
  return { host, home, p, node };
}

describe("versions", () => {
  test("parse and compare against the floor", () => {
    expect(parseVersion("v22.23.2\n")).toEqual([22, 23, 2]);
    expect(parseVersion("0.32.10 (some tool)")).toEqual([0, 32, 10]);
    expect(parseVersion("nope")).toBeNull();
    expect(compareVersions([22, 19, 0], NODE_MIN)).toBe(0);
    expect(compareVersions([20, 19, 0], NODE_MIN)).toBeLessThan(0);
    expect(compareVersions([26, 8, 2], NODE_MIN)).toBeGreaterThan(0);
  });
});

describe("where loki looks for Node", () => {
  test("the Mac looks where it always did, PATH first and nothing twice", () => {
    const { host, home, p } = fakeHost("macos", { path: "/x/bin:/opt/homebrew/bin" });
    const fnm = (dir: string) => p.join(dir, "aliases", "default", "bin");
    expect(binDirs(host)).toEqual([
      "/x/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      p.join(home, ".volta/bin"),
      p.join(home, ".bun/bin"),
      p.join(home, ".npm-global/bin"),
      p.join(home, ".local/bin"),
      fnm(p.join(home, "Library", "Application Support", "fnm")),
      fnm(p.join(home, ".local", "share", "fnm")),
      fnm(p.join(home, ".fnm")),
    ]);
  });

  test("covers AE4: a Mac with only nvm's Node, opened from Finder with a short PATH, finds it", async () => {
    const { host, home, p, node } = fakeHost("macos", { path: "/usr/bin:/bin" });
    node(p.join(home, ".nvm/versions/node/v22.1.0/bin"), "v22.1.0");
    node(p.join(home, ".nvm/versions/node/v24.1.0/bin"), "v24.1.0");
    expect(await findNode(host)).toMatchObject({ found: true, dir: p.join(home, ".nvm/versions/node/v24.1.0/bin"), version: [24, 1, 0] });
  });

  test("Windows splits PATH on semicolons, then looks in the installers' folders", () => {
    const home = "C:\\Users\\someone";
    const { host } = fakeHost("windows", {
      home,
      path: "C:\\Tools;D:\\bin;",
      env: {
        APPDATA: `${home}\\AppData\\Roaming`,
        LOCALAPPDATA: `${home}\\AppData\\Local`,
        ProgramFiles: "C:\\Program Files",
        NVM_SYMLINK: "C:\\nvm4w\\nodejs",
      },
    });
    const dirs = binDirs(host);
    expect(dirs.slice(0, 4)).toEqual(["C:\\Tools", "D:\\bin", `${home}\\AppData\\Roaming\\npm`, "C:\\Program Files\\nodejs"]);
    expect(dirs).toContain(`${home}\\AppData\\Local\\Volta\\bin`);
    expect(dirs).toContain("C:\\nvm4w\\nodejs");
    expect(dirs).toContain(`${home}\\AppData\\Roaming\\fnm\\aliases\\default`);
    expect(dirs).toContain(`${home}\\scoop\\shims`);
    expect(dirs).toContain(`${home}\\scoop\\apps\\nodejs\\current`);
    expect(dirs.some((d) => d.includes("homebrew"))).toBe(false);
  });

  test("Windows without its variables still looks in the home", () => {
    const { host, home } = fakeHost("windows", { path: "" });
    expect(binDirs(host)).toContain(`${home}\\AppData\\Roaming\\npm`);
  });

  test("a Windows Node is node.exe; a bare `node` file is not one", async () => {
    const nodejs = "C:\\Program Files\\nodejs";
    const { host, node } = fakeHost("windows", { path: "", env: { ProgramFiles: "C:\\Program Files" }, files: { [`${nodejs}\\node`]: "v24.1.0" } });
    expect(await findNode(host)).toEqual({ found: false, old: null });
    node(nodejs, "v24.1.0");
    expect(await findNode(host)).toMatchObject({ found: true, dir: nodejs });
  });

  test("Linux looks in /usr/bin and finds a Node that appears at the next look, since a miss is never kept", async () => {
    const { host, home, p, node } = fakeHost("linux", { path: "" });
    const dirs = binDirs(host);
    expect(dirs.slice(0, 2)).toEqual(["/usr/local/bin", "/usr/bin"]);
    expect(dirs.some((d) => d.includes("Library") || d.includes("/opt/homebrew"))).toBe(false);
    expect(await findNode(host)).toEqual({ found: false, old: null });
    node(p.join(home, ".nvm/versions/node/v22.19.0/bin"), "v22.19.0");
    expect(await findNode(host)).toMatchObject({ found: true, dir: p.join(home, ".nvm/versions/node/v22.19.0/bin") });
  });
});

describe("which Node wins", () => {
  test("the newest at or above the floor wins, wherever it sits in the list", async () => {
    const { host, home, p, node } = fakeHost("macos", { path: "" });
    node("/opt/homebrew/bin", "v22.20.0");
    node(p.join(home, ".nvm/versions/node/v24.1.0/bin"), "v24.1.0");
    expect(await findNode(host)).toMatchObject({ found: true, version: [24, 1, 0] });
  });

  test("a Node older than 22.19 is missing, and the newest of the old ones is named", async () => {
    const { host, home, p, node } = fakeHost("linux", { path: "" });
    node(p.join(home, ".nvm/versions/node/v18.20.4/bin"), "v18.20.4");
    node("/usr/bin", "v20.11.1");
    node(p.join(home, ".volta/bin"), "v22.18.0");
    expect(await findNode(host)).toEqual({ found: false, old: { version: [22, 18, 0], at: p.join(home, ".volta/bin/node") } });
  });

  test("a node without npx beside it is passed over for one that has both", async () => {
    const { host, home, p, node } = fakeHost("macos", { path: "" });
    node("/opt/homebrew/bin", "v25.0.0", false);
    node(p.join(home, ".volta/bin"), "v22.20.0");
    expect(await findNode(host)).toMatchObject({ found: true, dir: p.join(home, ".volta/bin") });
  });

  test("the Node a Tauri loki downloaded into ~/.loki/runtime never counts", async () => {
    const { host, home, p, node } = fakeHost("linux", { home: "/home/someone" });
    const runtime = p.join(home, ".loki/runtime/node-22.23.5-linux-x64/bin");
    const withRuntime = fakeHost("linux", { home, path: runtime });
    withRuntime.node(runtime, "v22.23.5");
    expect(await findNode(withRuntime.host)).toEqual({ found: false, old: null });
    node("/usr/bin", "v24.0.0");
    expect(await findNode(host)).toMatchObject({ found: true, dir: "/usr/bin" });
  });

  test("LOKI_NODE_BIN wins when it is new enough, and is passed over when it is not", async () => {
    const mine = "/home/someone/mine/node";
    const make = (version: string) => {
      const f = fakeHost("linux", { path: "", env: { LOKI_NODE_BIN: mine }, files: { [mine]: version } });
      f.node("/usr/bin", "v24.0.0");
      return f.host;
    };
    expect(await findNode(make("v25.0.0"))).toMatchObject({ found: true, node: mine });
    expect(await findNode(make("v20.11.1"))).toMatchObject({ found: true, dir: "/usr/bin" });
  });
});
