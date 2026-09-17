import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dateVersion, isDateVersion, isNightlyVersion, latestStable, nextStable, nightlyVersion, plan, releaseNotes, setVersion, withChangelog } from "../scripts/release.ts";
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
