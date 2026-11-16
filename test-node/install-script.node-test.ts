/**
 * The one-line install (docs/plans/2026-11-15-2319-feat-self-updating-install-plan.md, U7): site/public/install.sh run
 * with `sh` against a fake release on disk, in a scratch home, with uname, pgrep and ldconfig faked on PATH so both
 * the macOS and the Linux path run on either system. Nothing is opened and the real /Applications is never touched.
 * install.ps1 is only parsed, where PowerShell is installed. Runs under Node: npm run test:node
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const SCRIPT = resolve(import.meta.dirname, "..", "site", "public", "install.sh");
const PS_SCRIPT = resolve(import.meta.dirname, "..", "site", "public", "install.ps1");
const noSh = process.platform === "win32" ? "install.sh runs on macOS and Linux" : false;

interface Scratch {
  dir: string;
  home: string;
  tmp: string;
  apps: string;
  releases: string;
  bin: string;
}

/** A scratch dir with a home, a temp dir, an Applications folder, an empty release tree and the fake tools. */
function scratch(): Scratch {
  const dir = mkdtempSync(join(tmpdir(), "loki-install-"));
  const s: Scratch = {
    dir,
    home: join(dir, "home"),
    tmp: join(dir, "tmp"),
    apps: join(dir, "Applications"),
    releases: join(dir, "releases"),
    bin: join(dir, "bin"),
  };
  for (const d of [s.home, s.tmp, s.apps, s.releases, s.bin]) mkdirSync(d);
  tool(s, "uname", 'case "$1" in -m) echo "$FAKE_ARCH" ;; *) echo "$FAKE_SYSTEM" ;; esac');
  tool(s, "pgrep", '[ -n "${FAKE_RUNNING:-}" ]');
  tool(s, "ldconfig", '[ -n "${FAKE_NO_FUSE:-}" ] || echo "\tlibfuse.so.2 (libc6,x86-64) => /lib/x86_64-linux-gnu/libfuse.so.2"');
  return s;
}

function tool(s: Scratch, name: string, body: string): void {
  const file = join(s.bin, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

/** The folder a channel's files come from, as the script builds it from LOKI_DOWNLOAD_URL. */
function channelDir(s: Scratch, channel: "stable" | "nightly"): string {
  const dir = channel === "stable" ? join(s.releases, "latest", "download") : join(s.releases, "download", "nightly");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A release's macOS archive: loki.app with an Info.plist carrying `version`, as the updater's own archive is laid out. */
function macRelease(s: Scratch, channel: "stable" | "nightly", version: string): void {
  const stage = mkdtempSync(join(s.dir, "stage-"));
  mkdirSync(join(stage, "loki.app", "Contents"), { recursive: true });
  writeFileSync(join(stage, "loki.app", "Contents", "Info.plist"), `<plist><string>${version}</string></plist>\n`);
  const out = join(channelDir(s, channel), "loki-macos-universal.app.tar.gz");
  const tar = spawnSync("tar", ["-czf", out, "-C", stage, "loki.app"], { encoding: "utf8" });
  assert.equal(tar.status, 0, tar.stderr);
}

/**
 * A release's AppImage: a script that, like the real runtime, takes out its icon on `--appimage-extract`. `fuse2`
 * names libfuse.so.2 inside it, as the older AppImage runtime does.
 */
function linuxRelease(s: Scratch, channel: "stable" | "nightly", version: string, fuse2 = true): void {
  const lines = [
    "#!/bin/sh",
    `# ${version}`,
    fuse2 ? "# dlopen libfuse.so.2" : "",
    'if [ "$1" = --appimage-extract ]; then mkdir -p squashfs-root; echo png > squashfs-root/.DirIcon; fi',
  ];
  writeFileSync(join(channelDir(s, channel), "loki-linux-x86_64.AppImage"), lines.join("\n") + "\n");
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** install.sh as `sh install.sh …`, or, with `piped`, as `curl … | sh -s -- …` reads it. */
function install(s: Scratch, opts: { system?: string; arch?: string; args?: string[]; env?: Record<string, string>; piped?: boolean } = {}): Run {
  const env: Record<string, string> = {
    PATH: `${s.bin}${delimiter}${process.env.PATH ?? ""}`,
    HOME: s.home,
    TMPDIR: s.tmp,
    LOKI_DOWNLOAD_URL: pathToFileURL(s.releases).href,
    LOKI_APPLICATIONS_DIR: s.apps,
    LOKI_NO_OPEN: "1",
    FAKE_SYSTEM: opts.system ?? "Darwin",
    FAKE_ARCH: opts.arch ?? "arm64",
    ...opts.env,
  };
  const args = opts.args ?? [];
  const r = opts.piped
    ? spawnSync("sh", ["-s", "--", ...args], { env, encoding: "utf8", input: readFileSync(SCRIPT, "utf8") })
    : spawnSync("sh", [SCRIPT, ...args], { env, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Every path under `dir` with its contents, to show a run changed nothing. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) {
        out[relative(dir, p) + "/"] = "";
        walk(p);
      } else out[relative(dir, p)] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

/** `text` as a regular expression that matches it literally, for paths inside patterns. */
const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const plistOf = (app: string): string => readFileSync(join(app, "Contents", "Info.plist"), "utf8");

void test("on a Mac, loki goes into the Applications folder, unopened, and the temp files go", { skip: noSh }, () => {
  const s = scratch();
  try {
    macRelease(s, "stable", "stable-1");
    const r = install(s);
    assert.equal(r.status, 0, r.stderr);
    assert.match(plistOf(join(s.apps, "loki.app")), /stable-1/);
    assert.equal(r.stdout, `Downloading the latest loki.\nInstalling loki in ${s.apps}.\nDone. loki is in ${s.apps}.\n`);
    assert.deepEqual(readdirSync(s.tmp), []);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

void test("on a Mac whose Applications folder can't be written, loki goes into ~/Applications, made for it", { skip: noSh }, () => {
  const s = scratch();
  try {
    macRelease(s, "stable", "stable-1");
    const r = install(s, { env: { LOKI_APPLICATIONS_DIR: join(s.dir, "missing") } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(plistOf(join(s.home, "Applications", "loki.app")), /stable-1/);
    assert.match(r.stdout, new RegExp(`Installing loki in ${literal(join(s.home, "Applications"))}\\.`));
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

void test("AE6: running the line again replaces the app and leaves ~/.loki as it was", { skip: noSh }, () => {
  const s = scratch();
  try {
    macRelease(s, "stable", "stable-1");
    assert.equal(install(s).status, 0);
    writeFileSync(join(s.apps, "loki.app", "Contents", "stale"), "from the old version");
    mkdirSync(join(s.home, ".loki"));
    writeFileSync(join(s.home, ".loki", "agents.json"), '{"agents":["a"]}');
    const before = snapshot(join(s.home, ".loki"));

    macRelease(s, "stable", "stable-2");
    const r = install(s);
    assert.equal(r.status, 0, r.stderr);
    assert.match(plistOf(join(s.apps, "loki.app")), /stable-2/);
    assert.equal(existsSync(join(s.apps, "loki.app", "Contents", "stale")), false);
    assert.deepEqual(snapshot(join(s.home, ".loki")), before);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

void test("--nightly, piped into sh, and LOKI_CHANNEL=nightly fetch from the nightly release", { skip: noSh }, () => {
  const s = scratch();
  try {
    macRelease(s, "stable", "stable-1");
    macRelease(s, "nightly", "nightly-1");
    const piped = install(s, { args: ["--nightly"], piped: true });
    assert.equal(piped.status, 0, piped.stderr);
    assert.match(piped.stdout, /^Downloading the latest loki Nightly\./);
    assert.match(plistOf(join(s.apps, "loki.app")), /nightly-1/);

    rmSync(join(s.apps, "loki.app"), { recursive: true });
    const env = install(s, { env: { LOKI_CHANNEL: "nightly" } });
    assert.equal(env.status, 0, env.stderr);
    assert.match(plistOf(join(s.apps, "loki.app")), /nightly-1/);

    assert.equal(install(s).status, 0);
    assert.match(plistOf(join(s.apps, "loki.app")), /stable-1/);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

void test("an unsupported system or architecture, or an unknown option, stops with a message and changes nothing", { skip: noSh }, () => {
  const s = scratch();
  try {
    linuxRelease(s, "stable", "stable-1");
    const before = snapshot(s.dir);
    const arm = install(s, { system: "Linux", arch: "aarch64" });
    assert.equal(arm.status, 1);
    assert.equal(arm.stdout, "");
    assert.equal(
      arm.stderr,
      "loki for Linux runs on x86_64 only, and this machine is aarch64.\nUse loki on a Mac, on Windows, or on an x86_64 Linux machine.\n",
    );
    const bsd = install(s, { system: "FreeBSD", arch: "amd64" });
    assert.equal(bsd.status, 1);
    assert.match(bsd.stderr, /runs FreeBSD\.\nOn Windows, run this in PowerShell: irm https:\/\/almondlabs\.github\.io\/loki\/install\.ps1 \| iex\n$/);
    const option = install(s, { args: ["--beta"] });
    assert.equal(option.status, 1);
    assert.match(option.stderr, /^Unknown option: --beta\./);
    assert.deepEqual(snapshot(s.dir), before);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

void test("with loki running, the line says to quit it first and changes nothing", { skip: noSh }, () => {
  const s = scratch();
  try {
    macRelease(s, "stable", "stable-1");
    linuxRelease(s, "stable", "stable-1");
    assert.equal(install(s).status, 0);
    const before = snapshot(s.dir);
    for (const system of ["Darwin", "Linux"]) {
      const r = install(s, { system, arch: "x86_64", env: { FAKE_RUNNING: "1" } });
      assert.equal(r.status, 1, system);
      assert.equal(r.stderr, "loki is open, so it can't be replaced.\nQuit loki, then run the line again.\n");
    }
    assert.deepEqual(snapshot(s.dir), before);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

void test("on Linux, the AppImage goes to ~/.local/share/loki with a menu entry and icon, and a second run replaces it", { skip: noSh }, () => {
  const s = scratch();
  try {
    const data = join(s.home, ".local", "share");
    const app = join(data, "loki", "loki.AppImage");
    linuxRelease(s, "stable", "stable-1");
    const r = install(s, { system: "Linux", arch: "x86_64" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `Downloading the latest loki.\nInstalling loki in ${join(data, "loki")}.\nDone. loki is in ${join(data, "loki")}.\n`);
    assert.match(readFileSync(app, "utf8"), /stable-1/);
    assert.notEqual(statSync(app).mode & 0o111, 0);
    const entry = readFileSync(join(data, "applications", "loki.desktop"), "utf8");
    assert.match(entry, new RegExp(`^Exec="${literal(app)}" %U$`, "m"));
    assert.match(entry, new RegExp(`^Icon=${literal(join(data, "loki", "loki.png"))}$`, "m"));
    assert.equal(readFileSync(join(data, "loki", "loki.png"), "utf8"), "png\n");
    assert.deepEqual(readdirSync(s.tmp), []);

    mkdirSync(join(s.home, ".loki"));
    writeFileSync(join(s.home, ".loki", "agents.json"), '{"agents":["a"]}');
    linuxRelease(s, "stable", "stable-2");
    assert.equal(install(s, { system: "Linux", arch: "x86_64" }).status, 0);
    assert.match(readFileSync(app, "utf8"), /stable-2/);
    assert.equal(readFileSync(join(s.home, ".loki", "agents.json"), "utf8"), '{"agents":["a"]}');
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

void test("on Linux without FUSE 2, an AppImage that needs it stops with the command to install it; one that doesn't installs", { skip: noSh }, () => {
  const s = scratch();
  try {
    linuxRelease(s, "stable", "stable-1");
    const before = snapshot(s.home);
    const r = install(s, { system: "Linux", arch: "x86_64", env: { FAKE_NO_FUSE: "1" } });
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /^loki needs FUSE 2 \(libfuse2\), which isn't installed\.\nInstall it with .*(libfuse2|fuse-libs|fuse2).*, then run the line again\.\n$/,
    );
    assert.deepEqual(snapshot(s.home), before);
    assert.deepEqual(readdirSync(s.tmp), []);

    linuxRelease(s, "stable", "static-runtime", false);
    const ok = install(s, { system: "Linux", arch: "x86_64", env: { FAKE_NO_FUSE: "1" } });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(readFileSync(join(s.home, ".local", "share", "loki", "loki.AppImage"), "utf8"), /static-runtime/);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

const pwsh = ["pwsh", "powershell"].find((p) => spawnSync(p, ["-NoProfile", "-Command", "exit 0"]).status === 0);

void test("install.ps1 parses", { skip: pwsh ? false : "PowerShell isn't installed here" }, () => {
  const command = `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${PS_SCRIPT.replaceAll("'", "''")}', [ref]$null, [ref]$e); $e | ForEach-Object { $_.ToString() }; exit $e.Count`;
  const r = spawnSync(pwsh ?? "pwsh", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
