import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { attachPreview, dayNumber, hasPreviewFiles, isNightlyVersion, isStableVersion, latestStable, nextStable, nightlyVersion, plan, previewAction, previewLine, previewPr, publish, releaseNotes, releasePr, setVersion, shipping, stableVersion } from "../scripts/release.ts";
import { channelOf, isNewerVersion, nightlyVersionIn } from "../core/version.ts";

/** Releases on merge (scripts/release.ts): a stable is YYYY.MMDD.N, numbered when it is built; the tags are the truth. */

const day = (iso: string) => new Date(iso);
const OCT11 = day("2026-10-11T09:00:00Z");

describe("versions: the UTC day, then that day's count", () => {
  test("a stable is year, month and two-digit day, then the count from 0; a nightly is the next stable and the merge", () => {
    expect(dayNumber(OCT11)).toBe("1011");
    expect(dayNumber(day("2027-01-01T00:30:00Z"))).toBe("101");
    expect(dayNumber(day("2026-12-31T23:30:00-05:00"))).toBe("101"); // UTC decides: that is 2027-01-01 04:30 UTC
    expect(stableVersion(OCT11, 0)).toBe("2026.1011.0");
    expect(stableVersion(day("2026-11-05T12:00:00Z"), 2)).toBe("2026.1105.2");
    expect(isStableVersion("2026.1011.0")).toBe(true);
    expect(isStableVersion("2027.101.12")).toBe(true);
    expect(isStableVersion("2026.10.11")).toBe(false); // the old scheme
    expect(isStableVersion("2026.1311.0")).toBe(false); // no 13th month
    expect(isStableVersion("2026.1011.0-nightly.a96ee85")).toBe(false);
    expect(isNightlyVersion("2026.1011.1-nightly.a96ee85")).toBe(true);
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

  test("nightlies carry the stable they lead up to, so they sort after the last stable and before the next", () => {
    const tags = ["v2026.1011.0"];
    const n = nightlyVersion(OCT11, tags, "a96ee8512345");
    expect(n).toBe("2026.1011.1-nightly.a96ee85");
    expect(isNewerVersion("2026.1011.0", n)).toBe(true);
    expect(isNewerVersion(n, "2026.1011.1")).toBe(false); // equal parts: the app reads the stable as no newer…
    expect(channelOf(n)).toBe("nightly"); // …and a nightly build follows the nightly channel, not the stables
    expect(nightlyVersionIn(`loki ${n}`)).toBe(n);
    expect(nightlyVersionIn("loki 2026.1011.0")).toBeNull();
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
    const p = plan({ today: OCT11, sha: "a96ee8512345", tags, commitsSinceStable: 3 });
    expect(p).toMatchObject({ kind: "nightly", version: "2026.1011.0-nightly.a96ee85", nextPreview: "2026.10.11" });
    expect(plan({ today: OCT11, sha: "a96ee8512345", tags, commitsSinceStable: 0 }).kind).toBe("none");
  });

  test("the release PR landing is a stable, whatever the time of day and however many shipped today", () => {
    expect(plan({ today: OCT11, sha: "abc", tags, commitsSinceStable: 4, releaseMerged: true })).toMatchObject({ kind: "stable", version: "2026.1011.0" });
    const later = plan({ today: day("2026-10-11T23:59:00Z"), sha: "abc", tags: [...tags, "v2026.1011.0"], commitsSinceStable: 1, releaseMerged: true });
    expect(later).toMatchObject({ kind: "stable", version: "2026.1011.1" }); // a second the same day: .1, not tomorrow
    // even with nothing new: the person asked for a release (the build still decides its number)
    expect(plan({ today: OCT11, sha: "abc", tags, commitsSinceStable: 0, releaseMerged: true }).kind).toBe("stable");
  });

  test("the Windows and Linux PR landing is a preview of the stable it names; one naming no release builds nothing", () => {
    const shipped = ["2026.10.11", "2026.1011.0"];
    const withTag = [...tags, "v2026.1011.0"];
    expect(plan({ today: OCT11, sha: "abc", tags: withTag, shipped, commitsSinceStable: 2, previewMerged: "v2026.1011.0\n" })).toMatchObject({ kind: "preview", version: "2026.1011.0", nextPreview: "2026.1011.0" });
    expect(plan({ today: OCT11, sha: "abc", tags, shipped: ["2026.10.11"], commitsSinceStable: 2, previewMerged: "v2026.1011.0" })).toMatchObject({ kind: "none" });
    // a preview merge is never a stable too, even when the release marker moved in the same push
    expect(plan({ today: OCT11, sha: "abc", tags: withTag, shipped, commitsSinceStable: 2, releaseMerged: true, previewMerged: "v2026.1011.0" }).kind).toBe("preview");
  });

  test("before any stable, the first merge is a nightly of the first stable", () => {
    expect(plan({ today: OCT11, sha: "abc1234", tags: [], commitsSinceStable: 40 })).toMatchObject({ kind: "nightly", version: "2026.1011.0-nightly.abc1234", nextPreview: "" });
  });

  test("release commits (the release PR's, the Windows and Linux PR's) are not something to ship on their own", () => {
    const commits = [
      { sha: "1", subject: "release: Windows and Linux 2026.1011.0 (#15)", body: "" },
      { sha: "2", subject: "release: the next stable", body: "" },
      { sha: "3", subject: "inbox: a priority queue", body: "" },
    ];
    expect(shipping(commits).map((c) => c.sha)).toEqual(["3"]);
    expect(shipping(commits.slice(0, 2))).toEqual([]);
  });
});

describe("the release PR: no version of its own", () => {
  test("its title names no version, its one file records main, and its body says how the number is decided", () => {
    const { title, body, marker } = releasePr({ notes: "## 2026.1011.0\n\n- **inbox: a priority queue** (aaaaaaa)\n", mainSha: "f00dfeed", ifMergedNow: "2026.1011.0" });
    expect(title).toBe("release: the next stable");
    expect(title).not.toMatch(/\d{4}\./);
    expect(marker).toBe("f00dfeed\n");
    expect(body).toContain("YYYY.MMDD.N");
    expect(body).toContain("**2026.1011.0**");
    expect(body).toContain("- **inbox: a priority queue** (aaaaaaa)");
    expect(body).not.toContain("## 2026.1011.0");
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

  test("a stable's notes promise no Windows or Linux files: the preview line is added where those files are", () => {
    const notes = releaseNotes("2026.1011.0", [{ sha: "aaaaaaa1", subject: "inbox: a priority queue", body: "" }]);
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

describe("publish: the Mac's files, in one call", () => {
  // `release view` answers with `body` when the release exists, and fails as gh does when it does not
  const fakeGh = (body: string | null = null) => {
    const calls: string[][] = [];
    const gh = (...args: string[]) => {
      calls.push(args);
      if (args[1] === "view" && body === null) throw new Error("release not found");
      return args[1] === "view" ? body! : "";
    };
    return { calls, gh };
  };

  test("a nightly deletes the rolling release once and recreates it with the .dmg", () => {
    const { calls, gh } = fakeGh();
    const dmg = "dist/loki_2026.1011.1-nightly.a96ee85_universal.dmg";
    publish({ kind: "nightly", version: "2026.1011.1-nightly.a96ee85", files: [dmg], sha: "abc", notesFile: "notes.md", gh });
    expect(calls.map((c) => c.slice(0, 2))).toEqual([["release", "delete"], ["release", "create"]]);
    const create = calls[1];
    expect(create).toContain("nightly");
    expect(create).toContain("--prerelease");
    expect(create).toContain(dmg);
    expect(create.some((a) => /setup\.exe|AppImage|\.deb$/.test(a))).toBe(false);
  });

  test("a stable tags the merge and creates its release with the .dmg, marked latest", () => {
    const { calls, gh } = fakeGh();
    const dmg = "src-tauri/target/universal-apple-darwin/release/bundle/dmg/loki_2026.1011.0_universal.dmg";
    publish({ kind: "stable", version: "2026.1011.0", files: [dmg], sha: "f00dfeed", notesFile: "notes.md", gh });
    const writes = calls.filter((c) => c[1] !== "view");
    expect(writes.length).toBe(1);
    expect(writes[0].slice(0, 3)).toEqual(["release", "create", "v2026.1011.0"]);
    expect(writes[0][writes[0].indexOf("--target") + 1]).toBe("f00dfeed");
    expect(writes[0]).toContain(dmg);
    expect(writes[0]).toContain("--latest");
  });

  test("a stable whose number is already a release fails, and touches nothing: two builds' files never share a release", () => {
    const { calls, gh } = fakeGh("someone else's notes");
    expect(() => publish({ kind: "stable", version: "2026.1011.0", files: ["dist/loki_2026.1011.0_universal.dmg"], sha: "abc", notesFile: "n", gh })).toThrow(/already exists/);
    expect(calls.filter((c) => c[1] !== "view")).toEqual([]);
  });

  test("no files, or a version of the wrong kind, publishes nothing", () => {
    const { calls, gh } = fakeGh();
    expect(() => publish({ kind: "nightly", version: "2026.1011.1-nightly.a96ee85", files: [], sha: "abc", notesFile: "n", gh })).toThrow(/no files/);
    expect(() => publish({ kind: "stable", version: "2026.1011.1-nightly.a96ee85", files: ["x.dmg"], sha: "abc", notesFile: "n", gh })).toThrow(/looks like 2026.1011.0/);
    expect(() => publish({ kind: "stable", version: "2026.10.11", files: ["x.dmg"], sha: "abc", notesFile: "n", gh })).toThrow(/looks like 2026.1011.0/); // no new stable in the old scheme
    expect(() => publish({ kind: "preview", version: "2026.1011.0", files: ["x.dmg"], sha: "abc", notesFile: "n", gh })).toThrow(/stable or nightly/);
    expect(calls).toEqual([]);
  });
});

describe("the Windows and Linux PR: their files on the newest stable", () => {
  const assets = (v: string) => [`loki_${v}_universal.dmg`, "cask.rb", `loki_${v}_x64-setup.exe`, `loki_${v}_amd64.AppImage`, `loki_${v}_amd64.deb`];

  test("a release has its preview files only with all three: the -setup.exe, the AppImage and the .deb", () => {
    expect(hasPreviewFiles(assets("2026.1011.0"))).toBe(true);
    expect(hasPreviewFiles(["loki_2026.1011.0_universal.dmg", "cask.rb"])).toBe(false);
    expect(hasPreviewFiles(assets("2026.1011.0").filter((a) => !a.endsWith(".deb")))).toBe(false);
  });

  test("the PR opens while the stable lacks the files, closes once they are there or when there is no such release, and waits while a merged one builds", () => {
    const macOnly = ["loki_2026.1011.0_universal.dmg", "cask.rb"];
    expect(previewAction({ version: "2026.1011.0", assets: macOnly, marker: "v2026.10.11" })).toBe("open");
    expect(previewAction({ version: "2026.1011.0", assets: assets("2026.1011.0"), marker: "v2026.1011.0" })).toBe("close");
    expect(previewAction({ version: "2026.1011.0", assets: null, marker: "" })).toBe("close"); // nothing to put files on
    // main already records this version: the PR was merged and is building, or its build failed (re-run it)
    expect(previewAction({ version: "2026.1011.0", assets: macOnly, marker: "v2026.1011.0\n" })).toBe("wait");
  });

  test("the PR says what merging builds, from main, that the files join the Mac's stable, that they are unsigned previews, and where to report", () => {
    const { title, body, marker } = previewPr("2026.1011.0", "owner/loki");
    expect(title).toBe("release: Windows and Linux 2026.1011.0");
    expect(marker).toBe("v2026.1011.0\n");
    for (const f of ["loki_2026.1011.0_x64-setup.exe", "loki_2026.1011.0_amd64.AppImage", "loki_2026.1011.0_amd64.deb"]) expect(body).toContain(f);
    expect(body).toContain("`main`");
    expect(body).toContain("join the Mac's stable `v2026.1011.0`");
    expect(body).toContain("unsigned");
    expect(body).toContain(previewLine("owner/loki"));
    expect(body).not.toContain("midnight");
  });

  test("attaching uploads every file with --clobber and puts the preview line on the notes once", () => {
    const files = ["dist/loki_2026.1011.0_x64-setup.exe", "dist/appimage/loki_2026.1011.0_amd64.AppImage", "dist/deb/loki_2026.1011.0_amd64.deb"];
    const calls: string[][] = [];
    const gh = (...args: string[]) => (calls.push(args), args[1] === "view" ? "- **inbox: a priority queue** (aaaaaaa)" : "");
    attachPreview({ tag: "v2026.1011.0", files, repo: "owner/loki", gh });
    const upload = calls.find((c) => c[1] === "upload")!;
    expect(upload.slice(0, 3)).toEqual(["release", "upload", "v2026.1011.0"]);
    for (const f of files) expect(upload).toContain(f);
    expect(upload).toContain("--clobber");
    const edits = calls.filter((c) => c[1] === "edit");
    expect(edits.length).toBe(1);
    const notes = edits[0][edits[0].indexOf("--notes") + 1];
    expect(notes.startsWith(previewLine("owner/loki"))).toBe(true);
    expect(notes).toContain("- **inbox: a priority queue** (aaaaaaa)");
    expect(calls.some((c) => c[1] === "create")).toBe(false);
  });

  test("attaching again (a re-run) leaves notes that already carry the line alone", () => {
    const calls: string[][] = [];
    const gh = (...args: string[]) => (calls.push(args), args[1] === "view" ? `${previewLine("owner/loki")}\n\n- **a** (1111111)` : "");
    attachPreview({ tag: "v2026.1011.0", files: ["dist/loki_2026.1011.0_x64-setup.exe"], repo: "owner/loki", gh });
    expect(calls.filter((c) => c[1] === "edit")).toEqual([]);
    expect(calls.filter((c) => c[1] === "upload").length).toBe(1);
  });

  test("attaching to a stable with no release fails, and makes none: Windows and Linux never create a release", () => {
    const calls: string[][] = [];
    const gh = (...args: string[]) => {
      calls.push(args);
      if (args[1] === "view") throw new Error("release not found");
      return "";
    };
    expect(() => attachPreview({ tag: "v2026.1011.0", files: ["dist/loki_2026.1011.0_x64-setup.exe"], repo: "owner/loki", gh })).toThrow(/no release/);
    expect(calls.filter((c) => c[1] !== "view")).toEqual([]);
  });

  test("no files, or a tag that is not a stable, attaches nothing", () => {
    const calls: string[][] = [];
    const gh = (...args: string[]) => (calls.push(args), "");
    expect(() => attachPreview({ tag: "v2026.1011.0", files: [], repo: "owner/loki", gh })).toThrow(/no files/);
    expect(() => attachPreview({ tag: "nightly", files: ["x.exe"], repo: "owner/loki", gh })).toThrow(/stable tag/);
    expect(calls).toEqual([]);
  });
});

describe("the workflow: releases on merge, nothing on a schedule", () => {
  type Step = { id?: string; uses?: string; with?: Record<string, unknown>; run?: string };
  type Job = { if?: string; needs?: string | string[]; outputs?: Record<string, string>; concurrency?: { group?: string; "cancel-in-progress"?: unknown }; steps: Step[] };
  const wf = parseYaml(readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "release.yml"), "utf8")) as { on: Record<string, unknown>; jobs: Record<string, Job> };

  test("it runs on a push to main and by hand, never on a schedule", () => {
    expect(Object.keys(wf.on).sort()).toEqual(["push", "workflow_dispatch"]);
  });

  test("the build decides its number when it starts, in the stables' one-at-a-time queue, and stamps it", () => {
    const build = wf.jobs.build;
    expect(build.concurrency?.group).toBe("build-${{ needs.plan.outputs.kind }}");
    expect(build.concurrency?.["cancel-in-progress"]).toBe("${{ needs.plan.outputs.kind == 'nightly' }}");
    const decide = build.steps.find((s) => s.id === "version")!;
    expect(decide.run).toContain('npm run --silent release -- version "$KIND" "$GITHUB_SHA"');
    expect(decide.run).toContain('npm run release -- set "$VERSION"');
    expect(build.outputs?.version).toBe("${{ steps.version.outputs.version }}");
    // nothing reads a number decided before the build
    expect(JSON.stringify(build)).not.toContain("needs.plan.outputs.version");
  });

  test("the release PR and the Windows and Linux PR are refreshed on an ordinary merge, and a new stable offers the Windows and Linux PR", () => {
    expect(wf.jobs["release-pr"].if).toBe("needs.plan.outputs.kind == 'nightly'");
    expect(wf.jobs["preview-pr"].if).toBe(wf.jobs["release-pr"].if);
    expect(wf.jobs["release-pr"].steps.some((s) => s.run?.includes("npm run release -- release-pr"))).toBe(true);
    const after = wf.jobs["preview-pr-after-stable"];
    expect(after.needs).toEqual(["plan", "build"]);
    expect(after.if).toContain("needs.plan.outputs.kind == 'stable'");
    expect(after.steps.some((s) => s.run?.includes('preview-pr "${{ needs.build.outputs.version }}"'))).toBe(true);
  });

  test("Windows and Linux build the merge commit, not a tag, and stamp the stable's version", () => {
    for (const job of ["windows", "linux"]) {
      const checkout = wf.jobs[job].steps.find((s) => s.uses?.startsWith("actions/checkout"))!;
      expect(checkout.with?.ref).toBeUndefined();
      expect(wf.jobs[job].steps.some((s) => s.run?.includes('npm run release -- set "$VERSION"'))).toBe(true);
    }
  });
});
