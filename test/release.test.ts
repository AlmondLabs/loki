import { afterEach, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
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
  PR_NOTES_MAX,
  releasePr,
  setVersion,
  shipping,
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
  test("an ordinary merge with something since the last stable is a nightly; nothing new is nothing", () => {
    const p = plan({ today: OCT11, run: 4821, tags, commitsSinceStable: 3 });
    expect(p).toMatchObject({ kind: "nightly", version: "2026.1011.0-nightly.4821" });
    expect(plan({ today: OCT11, run: 4821, tags, commitsSinceStable: 0 }).kind).toBe("none");
  });

  test("the release PR landing is a stable, whatever the time of day and however many shipped today", () => {
    expect(plan({ today: OCT11, run: 4821, tags, commitsSinceStable: 4, releaseMerged: true })).toMatchObject({ kind: "stable", version: "2026.1011.0" });
    const later = plan({ today: day("2026-10-11T23:59:00Z"), run: 4821, tags: [...tags, "v2026.1011.0"], commitsSinceStable: 1, releaseMerged: true });
    expect(later).toMatchObject({ kind: "stable", version: "2026.1011.1" }); // a second the same day: .1, not tomorrow
    // even with nothing new: the person asked for a release (the build still decides its number)
    expect(plan({ today: OCT11, run: 4821, tags, commitsSinceStable: 0, releaseMerged: true }).kind).toBe("stable");
  });

  test("before any stable, the first merge is a nightly of the first stable", () => {
    expect(plan({ today: OCT11, run: 7, tags: [], commitsSinceStable: 40 })).toMatchObject({
      kind: "nightly",
      version: "2026.1011.0-nightly.7",
    });
  });

  test("release commits (the release PR's, and the retired Windows and Linux PR's) are not something to ship on their own", () => {
    const commits = [
      { sha: "1", subject: "release: Windows and Linux 2026.1011.0 (#15)", body: "" },
      { sha: "2", subject: "release: the next stable", body: "" },
      { sha: "3", subject: "inbox: a priority queue", body: "" },
      // The titles since they follow Conventional Commits; a change to release.ts itself still ships.
      { sha: "4", subject: "chore(release): the next stable (#80)", body: "" },
      { sha: "5", subject: "chore(release): the Windows and Linux preview 2026.1016.0", body: "" },
      { sha: "6", subject: "fix(release): number a stable after the last tag", body: "" },
    ];
    expect(shipping(commits).map((c) => c.sha)).toEqual(["3", "6"]);
    expect(shipping(commits.slice(0, 2))).toEqual([]);
  });
});

describe("the release PR: no version of its own", () => {
  test("its title names no version, its one file records main, and its body says how the number is decided", () => {
    const { title, body, marker } = releasePr({
      notes: "## 2026.1011.0\n\n- **inbox: a priority queue** (aaaaaaa)\n",
      mainSha: "f00dfeed",
      ifMergedNow: "2026.1011.0",
    });
    expect(title).toBe("chore(release): the next stable");
    expect(title).not.toMatch(/\d{4}\./);
    expect(marker).toBe("f00dfeed\n");
    expect(body).toContain("YYYY.MMDD.N");
    expect(body).toContain("**2026.1011.0**");
    expect(body).toContain("- **inbox: a priority queue** (aaaaaaa)");
    expect(body).not.toContain("## 2026.1011.0");
    // one merge ships all three systems: no second PR follows
    for (const what of ["Windows", "Linux", "`.dmg`"]) expect(body).toContain(what);
    expect(body).not.toContain("their own PR");
  });
});

describe("notes and files", () => {
  test("release notes: one entry per commit, newest first, release commits and trailers left out", () => {
    const notes = releaseNotes("2026.1011.0", [
      { sha: "bbbbbbb1", subject: "release: the next stable", body: "" },
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

  test("the release PR's body stays under GitHub's limit however much waits to ship", () => {
    const many = Array.from({ length: 2000 }, (_, i) => ({ sha: `${String(i).padStart(7, "0")}f`, subject: `chat: change ${i}`, body: "x ".repeat(200) }));
    const { body } = releasePr({ notes: releaseNotes("2026.1011.0", many, { max: PR_NOTES_MAX }), mainSha: "abc", ifMergedNow: "2026.1011.0" });
    expect(body.length).toBeLessThanOrEqual(65_536);
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
      [join("dmg", `loki_${version}_universal.dmg`)]: "dmg",
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
    const mac = { url: `${base}/loki_${V}_universal.app.tar.gz`, signature: "SIGMAC" };
    expect(latest).toEqual({
      version: V,
      notes: "- **a change** (aaaaaaa)\n",
      pub_date: "2026-11-16T09:00:00.000Z",
      platforms: {
        "darwin-universal": mac,
        "darwin-aarch64": mac,
        "darwin-x86_64": mac,
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
      `loki_${V}_universal.dmg`,
      `loki_${V}_universal.app.tar.gz`,
      `loki_${V}_universal.app.tar.gz.sig`,
      `loki_${V}_x64-setup.exe`,
      `loki_${V}_x64-setup.exe.sig`,
      `loki_${V}_amd64.AppImage`,
      `loki_${V}_amd64.AppImage.sig`,
      `loki_${V}_amd64.deb`,
    ]);
    expect(staged.rolling.map((f) => f.slice(to.length + 1))).toEqual([
      "latest.json",
      "loki-macos-universal.app.tar.gz",
      "loki-windows-x64-setup.exe",
      "loki-linux-x86_64.AppImage",
    ]);
    expect(INSTALL_FILES).toEqual(["loki-macos-universal.app.tar.gz", "loki-windows-x64-setup.exe", "loki-linux-x86_64.AppImage"]);
    // the copies are the updater's own files, so an install and an update fetch the same bytes
    expect(readFileSync(join(to, "loki-macos-universal.app.tar.gz"), "utf8")).toBe("mac archive");
    expect(readFileSync(join(to, "loki-windows-x64-setup.exe"), "utf8")).toBe("exe");
    expect(readFileSync(join(to, "loki-linux-x86_64.AppImage"), "utf8")).toBe("appimage");
    expect(readFileSync(join(to, `loki_${V}_universal.app.tar.gz.sig`), "utf8")).toBe("SIGMAC");
    expect(staged.dmg).toBe(join(to, `loki_${V}_universal.dmg`));
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
    `staged/loki_${V}_universal.dmg`,
    `staged/loki_${V}_universal.app.tar.gz`,
    `staged/loki_${V}_universal.app.tar.gz.sig`,
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
    const { calls, gh, writes } = fakeGh({ draft: false, target: "f00dfeed", assets: [`loki_${V}_universal.dmg`, "cask.rb", "latest.json"] });
    const out = publish({ kind: "stable", version: V, versioned, rolling, sha: "f00dfeed", notesFile: "notes.md", downloadDir: "shipped", gh });
    expect(writes()).toEqual([`release download v${V}`]);
    expect(calls.at(-1)).toContain(`loki_${V}_universal.dmg`);
    expect(out.dmg).toBe(join("shipped", `loki_${V}_universal.dmg`));
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
    const { calls, gh, writes } = fakeGh({ draft: false, target: "old", assets: ["loki_2026.1011.1-nightly.4820_universal.dmg"] });
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
      { draft: false, target: "newer", assets: ["loki_2026.1011.1-nightly.4822_universal.dmg"] },
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
      `loki_${old}_universal.dmg`,
      `loki_${old}_universal.app.tar.gz`,
      `loki_${old}_universal.app.tar.gz.sig`,
      `loki_${old}_x64-setup.exe`,
      `loki_${old}_amd64.AppImage.sig`,
      `loki_${old}_amd64.deb`,
      `loki_${now}_universal.dmg`,
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

  test("it runs on a push to main and by hand, never on a schedule; a merge of docs alone ships nothing", () => {
    expect(Object.keys(wf.on).sort()).toEqual(["push", "workflow_dispatch"]);
    const ignored = (wf.on.push as { "paths-ignore": string[] })["paths-ignore"];
    expect(ignored).toContain("docs/**");
    expect(ignored).not.toContain(".github/release.txt"); // the release PR's merge is a stable
  });

  test("plan, the version, a build per system and publish; the Windows and Linux PR and its jobs are gone", () => {
    expect(Object.keys(wf.jobs).sort()).toEqual(["linux", "macos", "plan", "publish", "release-pr", "version", "windows"]);
    expect(text).not.toMatch(/preview/i);
    expect(job("plan").outputs).toEqual({ kind: "${{ steps.plan.outputs.kind }}" });
  });

  test("the version is decided once, in the queued version job, which drafts a stable at that number straight away", () => {
    const version = job("version");
    expect(version.needs).toBe("plan");
    expect(version.concurrency).toEqual({
      group: "build-${{ github.event_name == 'push' && needs.plan.outputs.kind || github.run_id }}",
      "cancel-in-progress": "${{ needs.plan.outputs.kind == 'nightly' }}",
    });
    const decide = must(
      version.steps.find((s) => s.id === "version"),
      "the version step",
    );
    expect(decide.run).toContain('npm run --silent release -- version stable "$GITHUB_SHA"');
    expect(decide.run).toContain('npm run --silent release -- version nightly "$GITHUB_RUN_NUMBER"');
    // the draft only for a stable: the stable branch of the step makes it
    expect(decide.run).toMatch(/version stable "\$GITHUB_SHA"\)"\n\s*npm run release -- draft "\$VERSION"/);
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
    expect(String(job("macos").steps.find((s) => s.uses?.startsWith("tauri-apps/tauri-action@"))?.with?.args)).toBe("--target universal-apple-darwin");
    expect(runs(job("windows"))).toContain("npm run tauri -- build --bundles nsis");
    expect(runs(job("linux"))).toContain("npm run tauri -- build --bundles appimage,deb");
    const macPaths = String(job("macos").steps.find((s) => s.uses?.startsWith("actions/upload-artifact@"))?.with?.path);
    for (const f of ["loki_*_universal.dmg", "loki.app.tar.gz", "loki.app.tar.gz.sig"]) expect(macPaths).toContain(f);
  });

  test("a newer merge's nightly cancels an older one still building or publishing; stables and hand runs never queue behind each other", () => {
    const rolling = "${{ github.event_name == 'push' && needs.plan.outputs.kind == 'nightly' }}";
    const groups = new Set<string>();
    for (const name of [...builds, "publish"]) {
      const c = must(job(name).concurrency, `${name}'s concurrency`);
      expect(c["cancel-in-progress"], name).toBe(rolling);
      expect(c.group, name).toBe(`${name}-\${{ github.event_name == 'push' && needs.plan.outputs.kind == 'nightly' && 'nightly' || github.run_id }}`);
      groups.add(String(c.group));
    }
    expect(groups.size).toBe(4);
  });

  test("publish collects every build, then writes latest.json, the cask and the prune; only a push to main ever publishes", () => {
    const pub = job("publish");
    expect(([] as string[]).concat(pub.needs ?? []).sort()).toEqual(["linux", "macos", "plan", "version", "windows"]);
    expect(pub.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/main'");
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

  test("a run that is not a push to main never writes a release: only publish uploads, moves the tag or prunes", () => {
    for (const [name, j] of Object.entries(wf.jobs)) {
      if (name === "publish") continue;
      for (const write of ["release -- publish", "prune-nightly", "gh release", "git/refs/tags"]) expect(runs(j), `${name}: ${write}`).not.toContain(write);
    }
    // The version job writes one thing, a stable's draft (no tag until it is published), and a hand run is never a stable.
    expect(Object.keys(job("version").permissions ?? {})).toEqual(["contents"]);
  });

  test("the release PR is refreshed on an ordinary merge", () => {
    const pr = job("release-pr");
    expect(pr.if).toBe("needs.plan.outputs.kind == 'nightly'");
    expect(runs(pr)).toContain("npm run release -- release-pr");
  });
});
