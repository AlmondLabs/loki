import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachPreview, dateVersion, hasPreviewFiles, isDateVersion, isNightlyVersion, latestStable, nextStable, nightlyVersion, plan, previewAction, previewLine, previewPr, publish, releaseNotes, setVersion, shipping, withChangelog } from "../scripts/release.ts";
import { channelOf, isNewerVersion, nightlyVersionIn } from "../core/version.ts";

/** Date-based releases (scripts/release.ts): the calendar is the version, tags are the truth, one stable a day. */

const day = (iso: string) => new Date(iso);
const SEP28 = day("2026-09-28T09:00:00Z");

describe("versions from the calendar", () => {
  test("a stable is the UTC day, no leading zeros; a nightly adds the merge", () => {
    expect(dateVersion(SEP28)).toBe("2026.9.28");
    expect(dateVersion(day("2026-10-01T00:30:00Z"))).toBe("2026.10.1");
    expect(dateVersion(day("2026-09-30T23:30:00-05:00"))).toBe("2026.10.1"); // UTC decides, not the merger's clock
    expect(nightlyVersion(SEP28, "a96ee8512345")).toBe("2026.9.28-nightly.a96ee85");
    expect(isDateVersion("2026.9.28")).toBe(true);
    expect(isDateVersion("2026.9.28-nightly.a96ee85")).toBe(false);
    expect(isNightlyVersion("2026.9.28-nightly.a96ee85")).toBe(true);
    expect(isNightlyVersion("0.1.0")).toBe(false);
  });

  test("they order the way the app and Homebrew compare them: nightly after the stable before it, before the one after", () => {
    expect(isNewerVersion("0.1.0", "2026.9.28")).toBe(true); // the first date-based stable retires 0.1.0
    expect(isNewerVersion("2026.9.28", "2026.10.1")).toBe(true);
    expect(isNewerVersion("2026.9.28", "2026.9.29-nightly.abcdef0")).toBe(true);
    expect(isNewerVersion("2026.9.28-nightly.abcdef0", "2026.9.28")).toBe(false);
    expect(channelOf("2026.9.28-nightly.a96ee85")).toBe("nightly");
    expect(channelOf("2026.9.28")).toBe("stable");
    expect(nightlyVersionIn("loki 2026.9.28-nightly.a96ee85")).toBe("2026.9.28-nightly.a96ee85");
    expect(nightlyVersionIn("loki 2026.9.28")).toBeNull();
  });

  test("the latest stable is the newest v-tag; the next is today unless today already shipped", () => {
    const tags = ["v0.1.0", "v2026.9.3", "v2026.9.27", "nightly", "v2026.10.1-rc"];
    expect(latestStable(tags)).toBe("2026.9.27");
    expect(latestStable(["nightly"])).toBeNull();
    expect(nextStable(SEP28, tags)).toBe("2026.9.28");
    expect(nextStable(SEP28, [...tags, "v2026.9.28"])).toBe("2026.9.29");
  });
});

describe("what a run does", () => {
  const tags = ["v0.1.0", "v2026.9.27"];
  test("a merge with the files at the last stable is a nightly; nothing new is nothing", () => {
    const p = plan({ today: SEP28, sha: "a96ee8512345", fileVersion: "2026.9.27", tags, commitsSinceStable: 3 });
    expect(p).toMatchObject({ kind: "nightly", version: "2026.9.28-nightly.a96ee85", nextStable: "2026.9.28" });
    expect(plan({ today: SEP28, sha: "a96ee8512345", fileVersion: "2026.9.27", tags, commitsSinceStable: 0 }).kind).toBe("none");
  });
  test("the release PR landing (files ahead of the tags, dated today) is a stable", () => {
    expect(plan({ today: SEP28, sha: "abc", fileVersion: "2026.9.28", tags, commitsSinceStable: 4 })).toMatchObject({ kind: "stable", version: "2026.9.28" });
  });
  test("a release PR merged on the wrong day, or twice in a day, ships nothing and proposes the right number", () => {
    const stale = plan({ today: day("2026-10-02T10:00:00Z"), sha: "abc", fileVersion: "2026.9.28", tags, commitsSinceStable: 4 });
    expect(stale).toMatchObject({ kind: "repush", version: "2026.10.2", nextStable: "2026.10.2" });
    // 2026.9.28 shipped this morning, so the refreshed PR proposed tomorrow; merged today anyway, it waits
    const twice = plan({ today: SEP28, sha: "abc", fileVersion: "2026.9.29", tags: [...tags, "v2026.9.28"], commitsSinceStable: 1 });
    expect(twice).toMatchObject({ kind: "repush", version: "2026.9.29" });
    expect(twice.reason).toContain("one stable a day");
  });
  test("before any date-based stable, the old semver tag is the last stable and the first run is a nightly", () => {
    expect(plan({ today: SEP28, sha: "abc1234", fileVersion: "0.1.0", tags: ["v0.1.0"], commitsSinceStable: 40 })).toMatchObject({ kind: "nightly", nextStable: "2026.9.28" });
  });
  test("the preview PR landing (the push changed the marker to a stable's tag) is a preview of that tag, and no nightly", () => {
    const p = plan({ today: SEP28, sha: "a96ee8512345", fileVersion: "2026.9.27", tags, commitsSinceStable: 3, previewMerged: "v2026.9.27" });
    expect(p).toMatchObject({ kind: "preview", version: "2026.9.27", nextStable: "2026.9.28" });
    expect(p.reason).toContain("v2026.9.27");
    // the marker naming a tag that does not exist is an ordinary merge
    expect(plan({ today: SEP28, sha: "a96ee8512345", fileVersion: "2026.9.27", tags, commitsSinceStable: 3, previewMerged: "v2026.9.30" }).kind).toBe("nightly");
    // a stable landing still wins: the files moved, so this is the release PR, not the preview one
    expect(plan({ today: SEP28, sha: "abc", fileVersion: "2026.9.28", tags, commitsSinceStable: 4, previewMerged: "v2026.9.27" }).kind).toBe("stable");
  });
  test("release commits (the release PR's, the preview PR's) are not something to ship on their own", () => {
    const commits = [
      { sha: "1", subject: "release: Windows and Linux preview for v2026.9.27 (#15)", body: "" },
      { sha: "2", subject: "release: 2026.9.27", body: "" },
      { sha: "3", subject: "inbox: a priority queue", body: "" },
    ];
    expect(shipping(commits).map((c) => c.sha)).toEqual(["3"]);
    expect(shipping(commits.slice(0, 2))).toEqual([]);
  });
});

describe("notes and files", () => {
  test("release notes: one entry per commit, newest first, release commits and trailers left out", () => {
    const notes = releaseNotes("2026.9.28", [
      { sha: "bbbbbbb1", subject: "release: 2026.9.27", body: "" },
      { sha: "aaaaaaa1", subject: "inbox: a priority queue", body: "One score per card.\n\nCo-Authored-By: Someone <x@y>" },
      { sha: "ccccccc1", subject: "settings: the ladder", body: "" },
    ]);
    expect(notes).toBe("## 2026.9.28\n\n- **inbox: a priority queue** (aaaaaaa)\n  One score per card.\n- **settings: the ladder** (ccccccc)\n");
    expect(releaseNotes("2026.9.28", [])).toContain("no changes recorded");
  });

  test("a stable's notes promise no Windows or Linux files: those come later, from the preview PR", () => {
    const notes = releaseNotes("2026.9.28", [{ sha: "aaaaaaa1", subject: "inbox: a priority queue", body: "" }]);
    expect(notes).not.toContain("Windows");
    expect(notes).not.toContain("preview");
  });

  test("the preview line: Windows and Linux, built in CI, and where to report problems (R12)", () => {
    const line = previewLine("owner/loki");
    expect(line).toContain("Windows and Linux");
    expect(line).toContain("preview");
    expect(line).toContain("built and tested in CI, not yet tried on real machines");
    expect(line).toContain("https://github.com/owner/loki/issues");
  });

  test("setVersion stamps the three files and the lockfile's own entry, nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-release-"));
    try {
      mkdirSync(join(dir, "src-tauri"), { recursive: true });
      writeFileSync(join(dir, "package.json"), '{\n  "name": "loki",\n  "version": "0.1.0",\n  "dependencies": { "x": "0.1.0" }\n}\n');
      writeFileSync(join(dir, "src-tauri", "tauri.conf.json"), '{\n  "productName": "loki",\n  "version": "0.1.0"\n}\n');
      writeFileSync(join(dir, "src-tauri", "Cargo.toml"), '[package]\nname = "loki"\nversion = "0.1.0"\n\n[dependencies]\nserde = { version = "1" }\n');
      writeFileSync(join(dir, "src-tauri", "Cargo.lock"), '[[package]]\nname = "libc"\nversion = "0.1.0"\n\n[[package]]\nname = "loki"\nversion = "0.1.0"\ndependencies = []\n');
      expect(setVersion("2026.9.28", dir).sort()).toEqual(["package.json", "src-tauri/Cargo.lock", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json"]);
      expect(readFileSync(join(dir, "package.json"), "utf8")).toContain('"version": "2026.9.28"');
      expect(readFileSync(join(dir, "package.json"), "utf8")).toContain('"x": "0.1.0"');
      expect(readFileSync(join(dir, "src-tauri", "Cargo.toml"), "utf8")).toContain('version = "2026.9.28"');
      expect(readFileSync(join(dir, "src-tauri", "Cargo.toml"), "utf8")).toContain('serde = { version = "1" }');
      const lock = readFileSync(join(dir, "src-tauri", "Cargo.lock"), "utf8");
      expect(lock).toContain('name = "libc"\nversion = "0.1.0"');
      expect(lock).toContain('name = "loki"\nversion = "2026.9.28"');
      expect(setVersion("2026.9.28", dir)).toEqual([]); // already there
      expect(() => setVersion("v2026.9.28", dir)).toThrow(/not a version/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the changelog gets the new section on top, replacing one of the same version", () => {
    const first = withChangelog("", "## 2026.9.27\n\n- **a** (1111111)\n");
    expect(first.startsWith("# Changelog\n")).toBe(true);
    expect(first).toContain("## 2026.9.27\n\n- **a** (1111111)");
    const second = withChangelog(first, "## 2026.9.28\n\n- **b** (2222222)\n");
    expect(second.indexOf("## 2026.9.28")).toBeLessThan(second.indexOf("## 2026.9.27"));
    const refreshed = withChangelog(second, "## 2026.9.28\n\n- **b** (2222222)\n- **c** (3333333)\n");
    expect(refreshed.match(/## 2026\.9\.28/g)?.length).toBe(1);
    expect(refreshed).toContain("- **c** (3333333)");
    expect(refreshed).toContain("## 2026.9.27");
  });
});

describe("publish: the Mac's files, in one call", () => {
  const fakeGh = (answers: Record<string, string> = {}) => {
    const calls: string[][] = [];
    return { calls, gh: (...args: string[]) => (calls.push(args), answers[args.slice(0, 2).join(" ")] ?? "") };
  };

  test("a nightly deletes the rolling release once and recreates it with the .dmg", () => {
    const { calls, gh } = fakeGh();
    const dmg = "dist/loki_2026.9.28-nightly.a96ee85_universal.dmg";
    publish({ kind: "nightly", version: "2026.9.28-nightly.a96ee85", files: [dmg], sha: "abc", notesFile: "notes.md", gh });
    expect(calls.map((c) => c.slice(0, 2))).toEqual([["release", "delete"], ["release", "create"]]);
    const create = calls[1];
    expect(create).toContain("nightly");
    expect(create).toContain("--prerelease");
    expect(create).toContain(dmg);
    expect(create.some((a) => /setup\.exe|AppImage|\.deb$/.test(a))).toBe(false);
  });

  test("a stable tags and creates its release with the .dmg", () => {
    const { calls, gh } = fakeGh();
    const dmg = "src-tauri/target/universal-apple-darwin/release/bundle/dmg/loki_2026.9.28_universal.dmg";
    publish({ kind: "stable", version: "2026.9.28", files: [dmg], sha: "abc", notesFile: "notes.md", gh });
    expect(calls.length).toBe(1);
    expect(calls[0].slice(0, 3)).toEqual(["release", "create", "v2026.9.28"]);
    expect(calls[0]).toContain(dmg);
  });

  test("no files, or a version of the wrong kind, publishes nothing", () => {
    const { calls, gh } = fakeGh();
    expect(() => publish({ kind: "nightly", version: "2026.9.28-nightly.a96ee85", files: [], sha: "abc", notesFile: "n", gh })).toThrow(/no files/);
    expect(() => publish({ kind: "stable", version: "2026.9.28-nightly.a96ee85", files: ["x.dmg"], sha: "abc", notesFile: "n", gh })).toThrow(/date version/);
    expect(() => publish({ kind: "preview", version: "2026.9.28", files: ["x.dmg"], sha: "abc", notesFile: "n", gh })).toThrow(/stable or nightly/);
    expect(calls).toEqual([]);
  });
});

describe("the Windows and Linux preview: its own PR, attached to a stable that already shipped", () => {
  const assets = (v: string) => [`loki_${v}_universal.dmg`, "cask.rb", `loki_${v}_x64-setup.exe`, `loki_${v}_amd64.AppImage`, `loki_${v}_amd64.deb`];

  test("a release has its preview files only with all three: the -setup.exe, the AppImage and the .deb", () => {
    expect(hasPreviewFiles(assets("2026.9.24"))).toBe(true);
    expect(hasPreviewFiles(["loki_2026.9.24_universal.dmg", "cask.rb"])).toBe(false);
    expect(hasPreviewFiles(assets("2026.9.24").filter((a) => !a.endsWith(".deb")))).toBe(false);
  });

  test("the preview PR opens for a stable without its files, closes once they are there, and waits while a merged one builds", () => {
    const macOnly = ["loki_2026.9.24_universal.dmg", "cask.rb"];
    expect(previewAction({ latest: null, assets: null, marker: "" })).toBe("none"); // nothing shipped yet
    expect(previewAction({ latest: "2026.9.24", assets: null, marker: "" })).toBe("none"); // tagged, no release (yet)
    expect(previewAction({ latest: "2026.9.24", assets: macOnly, marker: "" })).toBe("open");
    expect(previewAction({ latest: "2026.9.24", assets: macOnly, marker: "v2026.9.23" })).toBe("open");
    expect(previewAction({ latest: "2026.9.24", assets: assets("2026.9.24"), marker: "v2026.9.24" })).toBe("close");
    expect(previewAction({ latest: "2026.9.24", assets: assets("2026.9.24"), marker: "v2026.9.20" })).toBe("close");
    // main already records this tag: the preview PR was merged and is building, or its build failed (re-run it)
    expect(previewAction({ latest: "2026.9.24", assets: macOnly, marker: "v2026.9.24" })).toBe("wait");
  });

  test("the PR says which stable it builds, what it builds, that the files are unsigned previews, and where to report", () => {
    const { title, body, marker } = previewPr("2026.9.24", "owner/loki");
    expect(title).toBe("release: Windows and Linux preview for v2026.9.24");
    expect(marker).toBe("v2026.9.24\n");
    expect(body).toContain("Windows and Linux preview for v2026.9.24");
    expect(body).toContain("`v2026.9.24`");
    for (const f of ["loki_2026.9.24_x64-setup.exe", "loki_2026.9.24_amd64.AppImage", "loki_2026.9.24_amd64.deb"]) expect(body).toContain(f);
    expect(body).toContain("unsigned");
    expect(body).toContain(previewLine("owner/loki"));
    expect(body).toContain("The Mac's `.dmg`, the casks and the nightly are not touched"); // the Mac is not rebuilt
  });

  test("attaching uploads every file to the tag with --clobber and puts the preview line on the notes once", () => {
    const files = ["dist/loki_2026.9.24_x64-setup.exe", "dist/appimage/loki_2026.9.24_amd64.AppImage", "dist/deb/loki_2026.9.24_amd64.deb"];
    const calls: string[][] = [];
    const gh = (...args: string[]) => (calls.push(args), args[1] === "view" ? "- **inbox: a priority queue** (aaaaaaa)" : "");
    attachPreview({ tag: "v2026.9.24", files, repo: "owner/loki", gh });
    const upload = calls.find((c) => c[1] === "upload")!;
    expect(upload.slice(0, 3)).toEqual(["release", "upload", "v2026.9.24"]);
    for (const f of files) expect(upload).toContain(f);
    expect(upload).toContain("--clobber");
    const edits = calls.filter((c) => c[1] === "edit");
    expect(edits.length).toBe(1);
    expect(edits[0].slice(0, 3)).toEqual(["release", "edit", "v2026.9.24"]);
    const notes = edits[0][edits[0].indexOf("--notes") + 1];
    expect(notes.startsWith(previewLine("owner/loki"))).toBe(true);
    expect(notes).toContain("- **inbox: a priority queue** (aaaaaaa)");
  });

  test("attaching again (a re-run) leaves notes that already carry the line alone", () => {
    const calls: string[][] = [];
    const gh = (...args: string[]) => (calls.push(args), args[1] === "view" ? `${previewLine("owner/loki")}\n\n- **a** (1111111)` : "");
    attachPreview({ tag: "v2026.9.24", files: ["dist/loki_2026.9.24_x64-setup.exe"], repo: "owner/loki", gh });
    expect(calls.filter((c) => c[1] === "edit")).toEqual([]);
    expect(calls.filter((c) => c[1] === "upload").length).toBe(1);
  });

  test("no files, or a tag that is not a stable, attaches nothing", () => {
    const calls: string[][] = [];
    const gh = (...args: string[]) => (calls.push(args), "");
    expect(() => attachPreview({ tag: "v2026.9.24", files: [], repo: "owner/loki", gh })).toThrow(/no files/);
    expect(() => attachPreview({ tag: "nightly", files: ["x.exe"], repo: "owner/loki", gh })).toThrow(/stable tag/);
    expect(calls).toEqual([]);
  });
});
