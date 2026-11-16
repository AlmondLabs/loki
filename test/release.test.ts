import { afterEach, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { field, holds } from "./fixtures/actions-expression.ts";
import { must } from "./fixtures/must.ts";
import {
  dayNumber,
  decideStable,
  draftStable,
  INSTALL_FILES,
  isNightlyVersion,
  isStableVersion,
  latestStable,
  nextStable,
  nightlyVersion,
  plan,
  publish,
  pruneNightly,
  stableFor,
  stageRelease,
  staleNightlyFiles,
  releaseNotes,
  requestedKind,
  setVersion,
  stableVersion,
  UPDATE_PLATFORMS,
} from "../scripts/release.ts";
import { channelOf, compareVersions } from "../core/version.ts";

/** Releases on merge (scripts/release.ts): a stable is YYYY.MMDD.N, numbered when it is built; the tags are the truth. */

const day = (iso: string) => new Date(iso);
const OCT11 = day("2026-10-11T09:00:00Z");

describe("versions: the UTC day, then that day's count", () => {
  test("a stable is year, month and two-digit day, then the count from 0; a nightly is the next stable and the run", () => {
    expect(dayNumber(OCT11)).toBe("1011");
    expect(dayNumber(day("2027-01-01T00:30:00Z"))).toBe("101");
    expect(dayNumber(day("2026-12-31T23:30:00-05:00"))).toBe("101"); // UTC decides: that is 2027-01-01 04:30 UTC
    expect(stableVersion(OCT11, 0)).toBe("2026.1011.0");
    expect(stableVersion(day("2026-11-05T12:00:00Z"), 2)).toBe("2026.1105.2");
    expect(isStableVersion("2026.1011.0")).toBe(true);
    expect(isStableVersion("2027.101.12")).toBe(true);
    expect(isStableVersion("2026.10.11")).toBe(false); // the old scheme
    expect(isStableVersion("2026.1311.0")).toBe(false); // no 13th month
    expect(isStableVersion("2026.1011.0-nightly.4821")).toBe(false);
    expect(isNightlyVersion("2026.1011.1-nightly.4821")).toBe(true);
    expect(isNightlyVersion("2026.1011.1-nightly.a96ee85")).toBe(false); // the old shape: no new nightly is numbered so
    expect(isNightlyVersion("2026.1011.1-nightly.04821")).toBe(false); // not semver: a number with a leading zero
    expect(isNightlyVersion("0.1.0")).toBe(false);
  });

  test("the next stable counts on from today's tags, ignoring other days, other schemes and other tags", () => {
    expect(nextStable(OCT11, [])).toBe("2026.1011.0");
    expect(nextStable(OCT11, ["v2026.10.10", "v2026.10.11", "nightly"])).toBe("2026.1011.0"); // the old scheme's Oct 11 is not today's count
    expect(nextStable(OCT11, ["v2026.1011.0"])).toBe("2026.1011.1");
    expect(nextStable(OCT11, ["v2026.1011.0", "v2026.1011.1", "v2026.1010.4"])).toBe("2026.1011.2");
    expect(nextStable(OCT11, ["v2026.1011.0", "v2026.1011.3"])).toBe("2026.1011.4"); // after the highest, never reusing one
    expect(nextStable(OCT11, ["v2026.1011.1-rc", "v2025.1011.0"])).toBe("2026.1011.0");
    expect(nextStable(day("2026-10-12T00:00:01Z"), ["v2026.1011.0", "v2026.1011.1"])).toBe("2026.1012.0");
  });

  test("nightlies carry the stable they lead up to and the run, so they sort after the last stable and before the next", () => {
    const tags = ["v2026.1011.0"];
    const n = nightlyVersion(nextStable(OCT11, tags), 4821);
    expect(n).toBe("2026.1011.1-nightly.4821");
    expect(isNightlyVersion(n)).toBe(true);
    expect(compareVersions("2026.1011.0", n)).toBeLessThan(0);
    expect(compareVersions(n, "2026.1011.1")).toBeLessThan(0); // the stable it led up to is newer: switching to Stable waits for it
    expect(compareVersions(n, nightlyVersion(nextStable(OCT11, tags), 4822))).toBeLessThan(0); // a later run of the same day
    expect(channelOf(n)).toBe("nightly");
  });

  test("the latest stable is the newest v-tag, across both schemes", () => {
    expect(latestStable(["v0.1.0", "v2026.9.28", "v2026.10.11", "nightly", "v2026.10.1-rc"])).toBe("2026.10.11");
    expect(latestStable(["v2026.10.11", "v2026.1011.0"])).toBe("2026.1011.0");
    expect(latestStable(["v2026.1011.0", "v2026.1011.1", "v2026.1012.0"])).toBe("2026.1012.0");
    expect(latestStable(["nightly"])).toBeNull();
  });
});

describe("what a run does", () => {
  const tags = ["v2026.10.11"];
  test("a run by hand asking for a stable is a stable, numbered today, however many shipped today", () => {
    expect(plan({ today: OCT11, run: 4821, tags, requested: "stable", commitsSinceStable: 4 })).toMatchObject({ kind: "stable", version: "2026.1011.0" });
    const later = plan({ today: day("2026-10-11T23:59:00Z"), run: 4821, tags: [...tags, "v2026.1011.0"], requested: "stable", commitsSinceStable: 1 });
    expect(later).toMatchObject({ kind: "stable", version: "2026.1011.1" }); // a second the same day: .1, not tomorrow
  });

  test("a run by hand asking for a nightly is a nightly of the next stable, numbered by the run", () => {
    expect(plan({ today: OCT11, run: 4821, tags, requested: "nightly", commitsSinceStable: 3 })).toMatchObject({
      kind: "nightly",
      version: "2026.1011.0-nightly.4821",
    });
  });

  test("nothing since the last stable is nothing to ship, whichever was asked for", () => {
    for (const requested of ["stable", "nightly"] as const)
      expect(plan({ today: OCT11, run: 4821, tags, requested, commitsSinceStable: 0 }), requested).toMatchObject({ kind: "none", version: "2026.10.11" });
  });

  test("before any stable, a run by hand is the first stable or a nightly of it", () => {
    expect(plan({ today: OCT11, run: 7, tags: [], requested: "nightly", commitsSinceStable: 40 })).toMatchObject({
      kind: "nightly",
      version: "2026.1011.0-nightly.7",
    });
    expect(plan({ today: OCT11, run: 7, tags: [], requested: "stable", commitsSinceStable: 40 })).toMatchObject({ kind: "stable", version: "2026.1011.0" });
  });

  test("the kind asked for comes from Run workflow's choice; a run without one, outside Actions, is a nightly", () => {
    expect(requestedKind("stable")).toBe("stable");
    expect(requestedKind("nightly")).toBe("nightly");
    expect(requestedKind(undefined)).toBe("nightly");
    expect(requestedKind("")).toBe("nightly");
    expect(() => requestedKind("beta")).toThrow(/stable or nightly/);
  });

  test("every commit since the last stable counts, release-scoped ones too", () => {
    const notes = releaseNotes("2026.1011.0", [
      { sha: "aaaaaaa1", subject: "chore(release): ship for apple silicon macs only", body: "" },
      { sha: "bbbbbbb1", subject: "fix(release): number a stable after the last tag", body: "" },
    ]);
    expect(notes).toContain("chore(release): ship for apple silicon macs only");
    expect(notes).toContain("fix(release): number a stable after the last tag");
  });
});

describe("notes and files", () => {
  test("release notes: one entry per commit, newest first, trailers left out", () => {
    const notes = releaseNotes("2026.1011.0", [
      { sha: "aaaaaaa1", subject: "inbox: a priority queue", body: "One score per card.\n\nCo-Authored-By: Someone <x@y>" },
      { sha: "ccccccc1", subject: "settings: the ladder", body: "" },
    ]);
    expect(notes).toBe("## 2026.1011.0\n\n- **inbox: a priority queue** (aaaaaaa)\n  One score per card.\n- **settings: the ladder** (ccccccc)\n");
    expect(releaseNotes("2026.1011.0", [])).toContain("no changes recorded");
  });

  test("notes too long for GitHub drop commit bodies first, then the oldest entries, with a link to the whole list", () => {
    const many = Array.from({ length: 400 }, (_, i) => ({
      sha: `${String(i).padStart(7, "0")}f`,
      subject: `chat: change ${i}`,
      body: "A paragraph about the change. ".repeat(10),
    }));
    const fits = releaseNotes("2026.1011.0", many, { max: 1_000_000 });
    expect(fits).toContain("A paragraph about the change.");
    const subjects = releaseNotes("2026.1011.0", many, { max: 20_000 });
    expect(subjects.length).toBeLessThanOrEqual(20_000);
    expect(subjects).not.toContain("A paragraph about the change.");
    expect(subjects).toContain("- **chat: change 399** (0000399)");
    const cut = releaseNotes("2026.1011.0", many, { max: 4_000, fullList: "https://github.com/o/loki/compare/v2026.1010.0...abc" });
    expect(cut.length).toBeLessThanOrEqual(4_000);
    expect(cut).toContain("- **chat: change 0** (0000000)"); // newest first: the newest stay
    expect(cut).not.toContain("chat: change 399");
    expect(cut).toMatch(/- and \d+ earlier changes: https:\/\/github\.com\/o\/loki\/compare\/v2026\.1010\.0\.\.\.abc\n$/);
  });

  test("setVersion stamps the three files and the lockfile's own entry, nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-release-"));
    try {
      mkdirSync(join(dir, "src-tauri"), { recursive: true });
      writeFileSync(join(dir, "package.json"), '{\n  "name": "loki",\n  "version": "0.1.0",\n  "dependencies": { "x": "0.1.0" }\n}\n');
      writeFileSync(join(dir, "src-tauri", "tauri.conf.json"), '{\n  "productName": "loki",\n  "version": "0.1.0"\n}\n');
      writeFileSync(join(dir, "src-tauri", "Cargo.toml"), '[package]\nname = "loki"\nversion = "0.1.0"\n\n[dependencies]\nserde = { version = "1" }\n');
      writeFileSync(
        join(dir, "src-tauri", "Cargo.lock"),
        '[[package]]\nname = "libc"\nversion = "0.1.0"\n\n[[package]]\nname = "loki"\nversion = "0.1.0"\ndependencies = []\n',
      );
      expect(setVersion("2026.1011.0", dir).sort()).toEqual(["package.json", "src-tauri/Cargo.lock", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json"]);
      expect(readFileSync(join(dir, "package.json"), "utf8")).toContain('"version": "2026.1011.0"');
      expect(readFileSync(join(dir, "package.json"), "utf8")).toContain('"x": "0.1.0"');
      expect(readFileSync(join(dir, "src-tauri", "Cargo.toml"), "utf8")).toContain('version = "2026.1011.0"');
      expect(readFileSync(join(dir, "src-tauri", "Cargo.toml"), "utf8")).toContain('serde = { version = "1" }');
      const lock = readFileSync(join(dir, "src-tauri", "Cargo.lock"), "utf8");
      expect(lock).toContain('name = "libc"\nversion = "0.1.0"');
      expect(lock).toContain('name = "loki"\nversion = "2026.1011.0"');
      expect(setVersion("2026.1011.0", dir)).toEqual([]); // already there
      expect(() => setVersion("v2026.1011.0", dir)).toThrow(/not a version/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the update files: what the three builds made, staged for the release (KTD9, KTD10)", () => {
  const V = "2026.1116.0";
  const NOW = day("2026-11-16T09:00:00Z");
  /** A download of the three builds' artifacts, laid out as actions/download-artifact merges them. */
  const builds = (version: string, leave: string[] = []) => {
    const dir = mkdtempSync(join(tmpdir(), "loki-builds-"));
    const files: Record<string, string> = {
      [join("dmg", `loki_${version}_aarch64.dmg`)]: "dmg",
      [join("macos", "loki.app.tar.gz")]: "mac archive",
      [join("macos", "loki.app.tar.gz.sig")]: "SIGMAC",
      [`loki_${version}_x64-setup.exe`]: "exe",
      [`loki_${version}_x64-setup.exe.sig`]: "SIGWIN",
      [join("appimage", `loki_${version}_amd64.AppImage`)]: "appimage",
      [join("appimage", `loki_${version}_amd64.AppImage.sig`)]: "SIGLINUX\n",
      [join("deb", `loki_${version}_amd64.deb`)]: "deb",
    };
    for (const [path, text] of Object.entries(files)) {
      if (leave.some((l) => path.endsWith(l))) continue;
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    return dir;
  };
  const scratch: string[] = [];
  const temp = (dir: string) => (scratch.push(dir), dir);
  const out = () => temp(mkdtempSync(join(tmpdir(), "loki-staged-")));
  afterEach(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("latest.json lists every platform the updater asks for, at the release's own versioned file, with its signature", () => {
    const to = out();
    stageRelease({ version: V, tag: `v${V}`, repo: "o/loki", notes: "- **a change** (aaaaaaa)\n", now: NOW, from: temp(builds(V)), to });
    const latest: unknown = JSON.parse(readFileSync(join(to, "latest.json"), "utf8"));
    const base = `https://github.com/o/loki/releases/download/v${V}`;
    const mac = { url: `${base}/loki_${V}_aarch64.app.tar.gz`, signature: "SIGMAC" };
    expect(latest).toEqual({
      version: V,
      notes: "- **a change** (aaaaaaa)\n",
      pub_date: "2026-11-16T09:00:00.000Z",
      platforms: {
        "darwin-aarch64": mac,
        "windows-x86_64": { url: `${base}/loki_${V}_x64-setup.exe`, signature: "SIGWIN" },
        "linux-x86_64": { url: `${base}/loki_${V}_amd64.AppImage`, signature: "SIGLINUX" },
      },
    });
    expect(Object.keys((latest as { platforms: object }).platforms).sort()).toEqual([...UPDATE_PLATFORMS].sort());
  });

  test("the versioned files keep the version in every name, and the install scripts' copies keep theirs", () => {
    const to = out();
    const staged = stageRelease({ version: V, tag: `v${V}`, repo: "o/loki", notes: "", now: NOW, from: temp(builds(V)), to });
    expect(staged.versioned.map((f) => f.slice(to.length + 1))).toEqual([
      `loki_${V}_aarch64.dmg`,
      `loki_${V}_aarch64.app.tar.gz`,
      `loki_${V}_aarch64.app.tar.gz.sig`,
      `loki_${V}_x64-setup.exe`,
      `loki_${V}_x64-setup.exe.sig`,
      `loki_${V}_amd64.AppImage`,
      `loki_${V}_amd64.AppImage.sig`,
      `loki_${V}_amd64.deb`,
    ]);
    expect(staged.rolling.map((f) => f.slice(to.length + 1))).toEqual([
      "latest.json",
      "loki-macos-arm64.app.tar.gz",
      "loki-windows-x64-setup.exe",
      "loki-linux-x86_64.AppImage",
    ]);
    expect(INSTALL_FILES).toEqual(["loki-macos-arm64.app.tar.gz", "loki-windows-x64-setup.exe", "loki-linux-x86_64.AppImage"]);
    // the copies are the updater's own files, so an install and an update fetch the same bytes
    expect(readFileSync(join(to, "loki-macos-arm64.app.tar.gz"), "utf8")).toBe("mac archive");
    expect(readFileSync(join(to, "loki-windows-x64-setup.exe"), "utf8")).toBe("exe");
    expect(readFileSync(join(to, "loki-linux-x86_64.AppImage"), "utf8")).toBe("appimage");
    expect(readFileSync(join(to, `loki_${V}_aarch64.app.tar.gz.sig`), "utf8")).toBe("SIGMAC");
    expect(staged.dmg).toBe(join(to, `loki_${V}_aarch64.dmg`));
  });

  test("a nightly's latest.json points at the rolling nightly release", () => {
    const N = "2026.1116.0-nightly.4900";
    const to = out();
    stageRelease({ version: N, tag: "nightly", repo: "o/loki", notes: "", now: NOW, from: temp(builds(N)), to });
    const latest = JSON.parse(readFileSync(join(to, "latest.json"), "utf8")) as { version: string; platforms: Record<string, { url: string }> };
    expect(latest.version).toBe(N);
    expect(latest.platforms["windows-x86_64"].url).toBe(`https://github.com/o/loki/releases/download/nightly/loki_${N}_x64-setup.exe`);
  });

  test("a missing signature fails, naming the platform, and stages nothing", () => {
    const to = out();
    expect(() => stageRelease({ version: V, tag: `v${V}`, repo: "o/loki", notes: "", now: NOW, from: temp(builds(V, [`_x64-setup.exe.sig`])), to })).toThrow(
      /windows-x86_64/,
    );
    expect(existsSync(join(to, "latest.json"))).toBe(false);
    expect(() => stageRelease({ version: V, tag: `v${V}`, repo: "o/loki", notes: "", now: NOW, from: temp(builds(V, ["loki.app.tar.gz.sig"])), to })).toThrow(
      /darwin-aarch64/,
    );
  });

  test("a missing bundle fails, naming the file", () => {
    expect(() => stageRelease({ version: V, tag: `v${V}`, repo: "o/loki", notes: "", now: NOW, from: temp(builds(V, [".deb"])), to: out() })).toThrow(
      `loki_${V}_amd64.deb`,
    );
  });
});

describe("the install scripts fetch the copies every release carries (KTD9)", () => {
  const script = (name: string) => readFileSync(join(import.meta.dirname, "..", "site", "public", name), "utf8");
  const RELEASES = "https://github.com/AlmondLabs/loki/releases";

  test("install.sh fetches the Mac and Linux copies, and install.ps1 the Windows one, from the stable or the nightly release", () => {
    const [mac, windows, linux] = INSTALL_FILES;
    const sh = script("install.sh");
    expect(sh).toContain(`releases_url="\${LOKI_DOWNLOAD_URL:-${RELEASES}}"`);
    expect(sh).toContain('base_url="$releases_url/latest/download"');
    expect(sh).toContain('base_url="$releases_url/download/nightly"');
    for (const file of [mac, linux]) expect(sh).toContain(`"$base_url/${file}"`);
    const ps = script("install.ps1");
    expect(ps).toContain(`else { "${RELEASES}" }`);
    expect(ps).toContain('$base = "$releases/latest/download"');
    expect(ps).toContain('$base = "$releases/download/nightly"');
    expect(ps).toContain(`"$base/${windows}"`);
  });
});

describe("publish: every system's files, each step safe to run again (plan 096)", () => {
  /**
   * gh as publishing meets it: `release view` answers the release's state, or its title when asked for `name` (or fails
   * as gh does), `release list` the public stables, the rest is recorded.
   */
  const fakeGh = (state: { draft: boolean; target: string; assets: string[] } | null = null, publicStables: string[] = [], title = "") => {
    const calls: string[][] = [];
    const gh = (...args: string[]) => {
      calls.push(args);
      if (args[1] === "list") return publicStables.join("\n");
      if (args[1] !== "view") return "";
      if (state === null) throw new Error("release not found");
      if (args[args.indexOf("--json") + 1] === "name") return title;
      return JSON.stringify({ isDraft: state.draft, targetCommitish: state.target, assets: state.assets.map((name) => ({ name })) });
    };
    const writes = () => calls.filter((c) => c[1] !== "view" && c[1] !== "list").map((c) => c.slice(0, 3).join(" "));
    return { calls, gh, writes };
  };
  const V = "2026.1011.0";
  const versioned = [
    `staged/loki_${V}_aarch64.dmg`,
    `staged/loki_${V}_aarch64.app.tar.gz`,
    `staged/loki_${V}_aarch64.app.tar.gz.sig`,
    `staged/loki_${V}_x64-setup.exe`,
    `staged/loki_${V}_x64-setup.exe.sig`,
    `staged/loki_${V}_amd64.AppImage`,
    `staged/loki_${V}_amd64.AppImage.sig`,
    `staged/loki_${V}_amd64.deb`,
  ];
  const rolling = ["staged/latest.json", ...INSTALL_FILES.map((f) => `staged/${f}`)];
  const uploads = (calls: string[][]) => calls.filter((c) => c[1] === "upload");

  test("a new stable is a draft first, gets every versioned file, then latest.json and the install copies, and is made public and latest last", () => {
    const { calls, gh, writes } = fakeGh();
    const out = publish({ kind: "stable", version: V, versioned, rolling, sha: "f00dfeed", notesFile: "notes.md", gh });
    expect(writes()).toEqual([`release create v${V}`, `release upload v${V}`, `release upload v${V}`, `release edit v${V}`]);
    const create = must(
      calls.find((c) => c[1] === "create"),
      "the create call",
    );
    expect(create).toContain("--draft");
    expect(create[create.indexOf("--target") + 1]).toBe("f00dfeed");
    expect(create).not.toContain("--latest");
    const [first, second] = uploads(calls);
    expect(first).toEqual(["release", "upload", `v${V}`, ...versioned, "--clobber"]);
    expect(second).toEqual(["release", "upload", `v${V}`, ...rolling, "--clobber"]);
    expect(calls.at(-1)).toEqual(["release", "edit", `v${V}`, "--draft=false", "--latest"]);
    expect(out.dmg).toBe(versioned[0]);
  });

  test("the draft the version job made gets the files and goes public, without a second release", () => {
    const { gh, writes } = fakeGh({ draft: true, target: "f00dfeed", assets: [] });
    publish({ kind: "stable", version: V, versioned, rolling, sha: "f00dfeed", notesFile: "notes.md", gh });
    expect(writes()).toEqual([`release upload v${V}`, `release upload v${V}`, `release edit v${V}`]);
  });

  test("a stable that finishes after a newer one went out is not made latest over it", () => {
    const { calls, gh } = fakeGh({ draft: true, target: "f00dfeed", assets: [] }, ["v2026.1011.1", "v2026.1010.0"]);
    publish({ kind: "stable", version: V, versioned, rolling, sha: "f00dfeed", notesFile: "notes.md", gh });
    expect(calls.at(-1)).toEqual(["release", "edit", `v${V}`, "--draft=false", "--latest=false"]);
  });

  test("a re-run after the stable went out changes nothing on it, and makes the cask from the .dmg it shipped with", () => {
    const { calls, gh, writes } = fakeGh({ draft: false, target: "f00dfeed", assets: [`loki_${V}_aarch64.dmg`, "cask.rb", "latest.json"] });
    const out = publish({ kind: "stable", version: V, versioned, rolling, sha: "f00dfeed", notesFile: "notes.md", downloadDir: "shipped", gh });
    expect(writes()).toEqual([`release download v${V}`]);
    expect(calls.at(-1)).toContain(`loki_${V}_aarch64.dmg`);
    expect(out.dmg).toBe(join("shipped", `loki_${V}_aarch64.dmg`));
  });

  test("a stable whose number is another commit's release fails, and touches nothing: two builds' files never share a release", () => {
    const { gh, writes } = fakeGh({ draft: false, target: "0ther0ne", assets: [] });
    expect(() => publish({ kind: "stable", version: V, versioned, rolling, sha: "f00dfeed", notesFile: "n", gh })).toThrow(/already exists for another commit/);
    expect(writes()).toEqual([]);
  });

  test("the first nightly creates the rolling release with its versioned files, then adds latest.json and the install copies", () => {
    const N = "2026.1011.1-nightly.4821";
    const { calls, gh, writes } = fakeGh();
    publish({ kind: "nightly", version: N, versioned, rolling, sha: "a96ee8512345", notesFile: "notes.md", repo: "o/loki", gh });
    expect(writes()).toEqual(["api -X DELETE", "release create nightly", "release upload nightly"]);
    const create = must(
      calls.find((c) => c[1] === "create"),
      "the create call",
    );
    expect(create).toContain("--prerelease");
    const title = create[create.indexOf("--title") + 1];
    expect(title).toBe("loki 2026.1011.1-nightly.4821 (2026.1011.1-nightly.a96ee85)"); // the commit, now the version has none
    // A nightly installed before run numbers reads the title with the old reader (kept here as it shipped) and finds a
    // version other than its own, so it still offers the update.
    const shippedReader = (t: string) => /\d+\.\d+\.\d+-nightly\.[0-9a-f]{7,40}/.exec(t)?.[0] ?? null;
    expect(shippedReader(title)).toBe("2026.1011.1-nightly.a96ee85");
    for (const f of versioned) expect(create).toContain(f);
    expect(calls.at(-1)).toEqual(["release", "upload", "nightly", ...rolling, "--clobber"]);
  });

  test("a nightly puts its files beside the last one's, moves the tag, and announces itself in latest.json last", () => {
    const N = "2026.1011.1-nightly.4821";
    const { calls, gh, writes } = fakeGh({ draft: false, target: "old", assets: ["loki_2026.1011.1-nightly.4820_aarch64.dmg"] });
    publish({ kind: "nightly", version: N, versioned, rolling, sha: "a96ee8512345", notesFile: "notes.md", repo: "o/loki", gh });
    expect(writes()).toEqual(["release upload nightly", "api -X PATCH", "release edit nightly", "release upload nightly"]);
    expect(calls.find((c) => c[2] === "PATCH")).toEqual([
      "api",
      "-X",
      "PATCH",
      "repos/o/loki/git/refs/tags/nightly",
      "-f",
      "sha=a96ee8512345",
      "-F",
      "force=true",
    ]);
    const edit = must(
      calls.find((c) => c[1] === "edit"),
      "the edit call",
    );
    expect(edit[edit.indexOf("--title") + 1]).toBe("loki 2026.1011.1-nightly.4821 (2026.1011.1-nightly.a96ee85)");
    expect(uploads(calls)).toEqual([
      ["release", "upload", "nightly", ...versioned, "--clobber"],
      ["release", "upload", "nightly", ...rolling, "--clobber"],
    ]);
    expect(calls.some((c) => c[1] === "delete")).toBe(false);
  });

  test("a re-run of an older nightly after a newer one went out stops before it uploads, moves the tag or edits the release", () => {
    const older = "2026.1011.1-nightly.4821";
    const { gh, writes } = fakeGh(
      { draft: false, target: "newer", assets: ["loki_2026.1011.1-nightly.4822_aarch64.dmg"] },
      [],
      "loki 2026.1011.1-nightly.4822 (2026.1011.1-nightly.0b1c2d3)",
    );
    expect(() => publish({ kind: "nightly", version: older, versioned, rolling, sha: "a96ee8512345", notesFile: "notes.md", repo: "o/loki", gh })).toThrow(
      "the nightly already announces 2026.1011.1-nightly.4822, newer than this run's 2026.1011.1-nightly.4821: nothing was published",
    );
    expect(writes()).toEqual([]);
  });

  test("a nightly publishes over the one it follows, and a re-run of the same nightly finishes what the last run left", () => {
    const N = "2026.1011.1-nightly.4821";
    for (const title of [
      "loki 2026.1011.1-nightly.4820 (2026.1011.1-nightly.7943572)",
      `loki ${N} (2026.1011.1-nightly.a96ee85)`,
      "loki 2026.1010.0-nightly.f00dfee",
    ]) {
      const { gh, writes } = fakeGh({ draft: false, target: "old", assets: [] }, [], title);
      publish({ kind: "nightly", version: N, versioned, rolling, sha: "a96ee8512345", notesFile: "notes.md", repo: "o/loki", gh });
      expect(writes(), title).toEqual(["release upload nightly", "api -X PATCH", "release edit nightly", "release upload nightly"]);
    }
  });

  test("after the tap moves, only files carrying an earlier version are removed: never latest.json or the install copies", () => {
    const old = "2026.1011.1-nightly.4820";
    const now = "2026.1011.1-nightly.4821";
    const assets = [
      `loki_${old}_aarch64.dmg`,
      `loki_${old}_aarch64.app.tar.gz`,
      `loki_${old}_aarch64.app.tar.gz.sig`,
      `loki_${old}_x64-setup.exe`,
      `loki_${old}_amd64.AppImage.sig`,
      `loki_${old}_amd64.deb`,
      `loki_${now}_aarch64.dmg`,
      `loki_${now}_x64-setup.exe`,
      `loki_${now}_amd64.AppImage.sig`,
      "latest.json",
      ...INSTALL_FILES,
      "cask.rb",
    ];
    const stale = assets.slice(0, 6);
    expect(staleNightlyFiles(assets, now)).toEqual(stale);
    const { calls, gh } = fakeGh({ draft: false, target: "abc", assets });
    expect(pruneNightly(now, gh)).toEqual(stale);
    expect(calls.filter((c) => c[1] === "delete-asset").map((c) => c[3])).toEqual(stale);
    expect(calls.at(-1)).toEqual(["release", "delete-asset", "nightly", `loki_${old}_amd64.deb`, "--yes"]);
    expect(pruneNightly(now, fakeGh().gh)).toEqual([]);
  });

  test("no files, or a version of the wrong kind, publishes nothing", () => {
    const { calls, gh } = fakeGh();
    expect(() => publish({ kind: "nightly", version: "2026.1011.1-nightly.4821", versioned: [], rolling, sha: "abc", notesFile: "n", gh })).toThrow(/no files/);
    expect(() => publish({ kind: "stable", version: "2026.1011.1-nightly.4821", versioned, rolling, sha: "abc", notesFile: "n", gh })).toThrow(
      /looks like 2026.1011.0/,
    );
    expect(() => publish({ kind: "stable", version: "2026.10.11", versioned, rolling, sha: "abc", notesFile: "n", gh })).toThrow(/looks like 2026.1011.0/); // no new stable in the old scheme
    expect(() => publish({ kind: "preview", version: V, versioned, rolling, sha: "abc", notesFile: "n", gh })).toThrow(/stable or nightly/);
    expect(calls).toEqual([]);
  });
});

describe("a stable's number: decided once, in the queue, and held by its draft (KTD10)", () => {
  test("the merge's own stable, draft or public, keeps its number; another merge's does not", () => {
    const releases = [
      { tag: "v2026.1011.0", target: "aaa" },
      { tag: "v2026.1011.1", target: "bbb" },
      { tag: "nightly", target: "bbb" },
    ];
    expect(stableFor("bbb", releases)).toBe("2026.1011.1");
    expect(stableFor("ccc", releases)).toBeNull();
    // A merge shipped twice before this change: the newer number is the one to finish.
    expect(stableFor("aaa", [...releases, { tag: "v2026.1011.2", target: "aaa" }])).toBe("2026.1011.2");
  });

  test("two stables started close together get .0 and .1, because the second sees the first one's draft", () => {
    // GitHub as the version jobs meet it: the releases, drafts included, and a create that adds one.
    const releases: Array<{ tag: string; target: string }> = [];
    const calls: string[][] = [];
    const gh = (...args: string[]) => {
      calls.push(args);
      const found = releases.find((r) => r.tag === args[2]);
      if (args[1] === "view") {
        if (!found) throw new Error("release not found");
        return JSON.stringify({ isDraft: true, targetCommitish: found.target, assets: [] });
      }
      if (args[1] === "create") releases.push({ tag: args[2] ?? "", target: args[args.indexOf("--target") + 1] ?? "" });
      return "";
    };
    const first = decideStable({ today: OCT11, sha: "aaa", tags: ["v2026.1010.3"], releases });
    draftStable({ version: first, sha: "aaa", notesFile: "notes.md", gh });
    const second = decideStable({ today: OCT11, sha: "bbb", tags: ["v2026.1010.3"], releases });
    draftStable({ version: second, sha: "bbb", notesFile: "notes.md", gh });
    expect([first, second]).toEqual(["2026.1011.0", "2026.1011.1"]);
    const creates = calls.filter((c) => c[1] === "create");
    expect(creates).toHaveLength(2);
    expect(creates[0]).toEqual(["release", "create", "v2026.1011.0", "--draft", "--target", "aaa", "--title", "loki 2026.1011.0", "--notes-file", "notes.md"]);
    // a re-run of the first merge takes its own number back and makes no second draft
    expect(decideStable({ today: OCT11, sha: "aaa", tags: [], releases })).toBe("2026.1011.0");
    draftStable({ version: "2026.1011.0", sha: "aaa", notesFile: "notes.md", gh });
    expect(calls.filter((c) => c[1] === "create")).toHaveLength(2);
    // a number another merge holds is never joined
    expect(() => draftStable({ version: "2026.1011.0", sha: "ccc", notesFile: "notes.md", gh })).toThrow(/another commit/);
    expect(() => draftStable({ version: "2026.1011.1-nightly.4", sha: "ccc", notesFile: "notes.md", gh })).toThrow(/looks like 2026.1011.0/);
  });
});

describe("the workflow: one run builds all three systems, for a stable and a nightly", () => {
  interface Step {
    id?: string;
    if?: string;
    uses?: string;
    with?: Record<string, unknown>;
    env?: Record<string, string>;
    run?: string;
  }
  interface Job {
    if?: string;
    "runs-on": string;
    needs?: string | string[];
    env?: Record<string, string>;
    outputs?: Record<string, string>;
    permissions?: Record<string, string>;
    concurrency?: { group?: string; "cancel-in-progress"?: unknown };
    steps: Step[];
  }
  const text = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "release.yml"), "utf8");
  const wf = parseYaml(text) as { on: Record<string, unknown>; jobs: Record<string, Job> };
  const job = (name: string) => must(wf.jobs[name], `the ${name} job`);
  const runs = (j: Job) => j.steps.map((s) => s.run ?? "").join("\n");
  const builds = ["macos", "windows", "linux"];

  test("it runs only by hand, with a choice of nightly or stable; a merge starts nothing, and nothing runs on a schedule", () => {
    expect(Object.keys(wf.on)).toEqual(["workflow_dispatch"]);
    const kind = (wf.on.workflow_dispatch as { inputs: { kind: { type: string; options: string[]; default: string } } }).inputs.kind;
    expect(kind).toMatchObject({ type: "choice", options: ["nightly", "stable"], default: "nightly" });
    expect(job("plan").steps.find((s) => s.id === "plan")?.env?.REQUESTED_KIND).toBe("${{ inputs.kind }}");
  });

  test("plan, the version, a build per system and publish; the release PR and the Windows and Linux PR are gone", () => {
    expect(Object.keys(wf.jobs).sort()).toEqual(["linux", "macos", "plan", "publish", "version", "windows"]);
    expect(text).not.toMatch(/preview|release-pr|release\/next|release\.txt|RELEASE_TOKEN/i);
    expect(job("plan").outputs).toEqual({ kind: "${{ steps.plan.outputs.kind }}" });
  });

  test("the version is decided once, in the queued version job, which drafts a stable at that number straight away", () => {
    const version = job("version");
    expect(version.needs).toBe("plan");
    const decide = must(
      version.steps.find((s) => s.id === "version"),
      "the version step",
    );
    expect(decide.run).toContain('npm run --silent release -- version stable "$GITHUB_SHA"');
    expect(decide.run).toContain('npm run --silent release -- version nightly "$GITHUB_RUN_NUMBER"');
    expect(decide.run).not.toContain("draft");
    const draft = must(
      version.steps.find((s) => s.run?.includes('npm run release -- draft "$VERSION"')),
      "the draft step",
    );
    expect(draft.env?.VERSION).toBe("${{ steps.version.outputs.version }}");
    // the notes this run ships, in the run's summary while it builds
    expect(runs(version)).toContain('npm run --silent release -- notes "$VERSION" >> "$GITHUB_STEP_SUMMARY"');
    expect(version.outputs?.version).toBe("${{ steps.version.outputs.version }}");
    // nothing reads a number decided before the queue
    expect(text).not.toContain("needs.plan.outputs.version");
  });

  test("a build per system for both kinds, each stamping the queued version and handing its files to publish", () => {
    const runners = { macos: "macos-15", windows: "windows-latest", linux: "ubuntu-22.04" } as const;
    for (const name of builds) {
      const j = job(name);
      expect(j["runs-on"], name).toBe(runners[name as keyof typeof runners]);
      expect(j.needs, name).toEqual(["plan", "version"]);
      expect(j.if, name).toBeUndefined(); // stable and nightly alike
      expect(j.env?.VERSION, name).toBe("${{ needs.version.outputs.version }}");
      expect(runs(j), name).toContain('npm run release -- set "$VERSION"');
      expect(runs(j), name).toContain("npm run build:mod && npm run smoke");
      const checkout = must(
        j.steps.find((s) => s.uses?.startsWith("actions/checkout")),
        `${name}'s checkout`,
      );
      expect(checkout.with?.ref, name).toBeUndefined(); // the merge commit, not a tag
      const upload = must(
        j.steps.find((s) => s.uses?.startsWith("actions/upload-artifact@")),
        `${name}'s upload`,
      );
      expect(upload.with?.["if-no-files-found"], name).toBe("error");
      expect(String(upload.with?.path), name).toContain(".sig");
    }
    expect(String(job("macos").steps.find((s) => s.uses?.startsWith("tauri-apps/tauri-action@"))?.with?.args)).toBe("--target aarch64-apple-darwin");
    expect(runs(job("windows"))).toContain("npm run tauri -- build --bundles nsis");
    expect(runs(job("linux"))).toContain("npm run tauri -- build --bundles appimage,deb");
    const macPaths = String(job("macos").steps.find((s) => s.uses?.startsWith("actions/upload-artifact@"))?.with?.path);
    for (const f of ["dmg/loki_*_aarch64.dmg", "macos/loki.app.tar.gz", "macos/loki.app.tar.gz.sig"])
      expect(macPaths).toContain(`src-tauri/target/aarch64-apple-darwin/release/bundle/${f}`);
    // Apple silicon only: the one Rust target, no Intel or universal build.
    expect(String(job("macos").steps.find((s) => s.uses?.startsWith("dtolnay/rust-toolchain@"))?.with?.targets)).toBe("aarch64-apple-darwin");
  });

  test("publish collects every build, then writes latest.json, the cask and the prune", () => {
    const pub = job("publish");
    expect(([] as string[]).concat(pub.needs ?? []).sort()).toEqual(["linux", "macos", "plan", "version", "windows"]);
    expect(pub.steps.some((s) => s.uses?.startsWith("actions/download-artifact@"))).toBe(true);
    const at = (part: string) => pub.steps.findIndex((s) => s.run?.includes(part));
    const publishStep = must(
      pub.steps.find((s) => s.id === "publish"),
      "the publish step",
    );
    expect(publishStep.run).toContain('npm run release -- publish "$KIND" "$VERSION" dist');
    expect(pub.steps[at("npm run --silent cask")]?.run).toContain("steps.publish.outputs.dmg");
    const prune = at('npm run release -- prune-nightly "$VERSION"');
    expect(prune).toBeGreaterThan(at("git push --quiet origin main"));
    expect(pub.steps[prune]?.if).toBe("env.KIND == 'nightly'");
    // A publish that stops (a re-run of an older nightly, say) fails its step, and nothing after it runs: no cask, no
    // tap push, no prune. A status check such as always() on a later step would let it run anyway.
    for (const step of pub.steps.slice(pub.steps.indexOf(publishStep) + 1)) expect(step.if ?? "").not.toMatch(/always\(\)|failure\(\)|cancelled\(\)/);
  });

  test("only publish writes a release: uploads, moves the tag or prunes", () => {
    for (const [name, j] of Object.entries(wf.jobs)) {
      if (name === "publish") continue;
      for (const write of ["release -- publish", "prune-nightly", "gh release", "git/refs/tags"]) expect(runs(j), `${name}: ${write}`).not.toContain(write);
    }
    // The version job writes one thing, a stable's draft on main (no tag until it is published).
    expect(Object.keys(job("version").permissions ?? {})).toEqual(["contents"]);
  });

  // What a run starts, as Actions would: the plan's kind from plan() for the kind asked for, then each job in order
  // when everything it needs ran and its `if:` holds, and the queue each job joins.
  const RUN = "9001";
  const scenario = ({ requested, ref, commitsSinceStable = 3 }: { requested: "stable" | "nightly"; ref: string; commitsSinceStable?: number }) => {
    const kind = plan({ today: OCT11, run: 4821, tags: ["v2026.10.11"], requested, commitsSinceStable }).kind;
    const context = { "github.ref": ref, "github.run_id": RUN, "needs.plan.outputs.kind": kind, "env.KIND": kind };
    const ran = new Set<string>();
    for (const [name, j] of Object.entries(wf.jobs)) if (([] as string[]).concat(j.needs ?? []).every((n) => ran.has(n)) && holds(j.if, context)) ran.add(name);
    const queue = (name: string) => {
      const c = must(job(name).concurrency, `${name}'s concurrency`);
      return { group: field(c.group, context), cancel: field(c["cancel-in-progress"], context) };
    };
    const step = (j: string, part: string) =>
      holds(
        must(
          job(j).steps.find((s) => s.run?.includes(part)),
          `${j}'s ${part}`,
        ).if,
        context,
      );
    return { kind, ran: [...ran].sort(), queue, drafts: ran.has("version") && step("version", "release -- draft"), prunes: step("publish", "prune-nightly") };
  };
  const shipsAll = ["linux", "macos", "plan", "publish", "version", "windows"];

  test("a stable asked for on main ships a stable of main: drafted at its number, every build and publish in queues of their own, no prune", () => {
    const run = scenario({ requested: "stable", ref: "refs/heads/main" });
    expect(run.kind).toBe("stable");
    expect(run.ran).toEqual(shipsAll);
    expect(run.drafts).toBe(true);
    expect(run.queue("version")).toEqual({ group: "build-stable", cancel: false });
    for (const name of [...builds, "publish"]) expect(run.queue(name), name).toEqual({ group: `${name}-${RUN}`, cancel: false });
    expect(run.prunes).toBe(false);
  });

  test("a nightly asked for on main ships a nightly of main in the nightly queues, where a newer nightly cancels it", () => {
    const run = scenario({ requested: "nightly", ref: "refs/heads/main" });
    expect(run.kind).toBe("nightly");
    expect(run.ran).toEqual(shipsAll);
    expect(run.drafts).toBe(false);
    expect(run.queue("version")).toEqual({ group: "build-nightly", cancel: true });
    for (const name of [...builds, "publish"]) expect(run.queue(name), name).toEqual({ group: `${name}-nightly`, cancel: true });
    expect(run.prunes).toBe(true);
  });

  test("nothing since the last stable builds nothing, whichever was asked for", () => {
    for (const requested of ["stable", "nightly"] as const)
      expect(scenario({ requested, ref: "refs/heads/main", commitsSinceStable: 0 }).ran, requested).toEqual(["plan"]);
  });

  test("a run from a branch builds all three and publishes nothing, in queues of its own; a stable there drafts nothing", () => {
    for (const requested of ["stable", "nightly"] as const) {
      const run = scenario({ requested, ref: "refs/heads/fix/phone-banner" });
      expect(run.kind, requested).toBe(requested);
      expect(run.ran, requested).toEqual(["linux", "macos", "plan", "version", "windows"]);
      expect(run.drafts, requested).toBe(false);
      expect(run.queue("version").group, requested).toBe(`build-${RUN}`);
      for (const name of builds) expect(run.queue(name), `${requested} ${name}`).toEqual({ group: `${name}-${RUN}`, cancel: false });
    }
  });

  test("publish holds only on main, for a stable or a nightly", () => {
    const publishes = (ref: string, kind: string) => holds(job("publish").if, { "github.ref": ref, "needs.plan.outputs.kind": kind });
    expect(publishes("refs/heads/main", "stable")).toBe(true);
    expect(publishes("refs/heads/main", "nightly")).toBe(true);
    expect(publishes("refs/heads/main", "none")).toBe(false);
    for (const kind of ["stable", "nightly"]) expect(publishes("refs/heads/fix/phone-banner", kind), kind).toBe(false);
  });
});
