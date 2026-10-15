// Release management (docs/RELEASING.md). A stable ships when the release PR merges, as many a day as there are
// merges.
//
// A stable is `YYYY.MMDD.N`: the UTC year, then month and day (October 11 is 1011, January 1 is 101), then that day's
// release count from 0 — 2026.1011.0, 2026.1011.1, 2026.1012.0. A nightly is the next stable's number and the merge
// that built it: `2026.1011.1-nightly.a96ee85`. The number is decided when the release is built, from the date and the
// stable tags, never written into a PR beforehand, so nothing goes stale and nothing runs on a schedule. The tags are
// the truth; the version files on main are stamped only on the runner (main takes changes through PRs alone).
// `.github/workflows/release.yml` runs this on every push to main, and by hand:
//
//   npm run release -- plan                    what this run does: stable | nightly | preview | none
//   npm run release -- version <stable|nightly> [sha]   the number this build gets, from the tags as they are now
//   npm run release -- set <version>           stamp the three version files (+ Cargo.lock), uncommitted
//   npm run release -- notes [version]         release notes from the commits since the last stable
//   npm run release -- release-pr              create, refresh or close the one release PR (branch release/next)
//   npm run release -- publish <kind> <version> <dmg…>   the GitHub release: a new vX, or the rolling nightly
//   npm run release -- preview-pr [version]    create, refresh or close the Windows and Linux PR (branch release/preview)
//   npm run release -- attach <tag> <files…>   the Windows and Linux files onto the stable vX
//
// Windows and Linux are previews and only ever stables (plan 014 R12): their PR puts their files on the newest stable
// that lacks them, built from main as it is at that merge. Nightlies are the Mac's alone.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseVersion } from "../core/version.ts";

export type Kind = "stable" | "nightly" | "preview" | "none";
export interface Plan {
  kind: Kind;
  /**
   * What this run builds: a preview's stable, a nightly's number, or a stable's number as the tags stand now — the
   * build decides a stable's again when it starts (`version`), after any stable queued before it has tagged.
   */
  version: string;
  /** The stable the Windows and Linux PR targets after this run: the newest the Mac has shipped. */
  nextPreview: string;
  reason: string;
}

export const RELEASE_BRANCH = "release/next";
/** The release PR's one file: the main it was built from. Merging it is what makes a run a stable. */
export const RELEASE_FILE = ".github/release.txt";
/** The Windows and Linux PR's branch, and the one file its commit changes: the tag its files go on, `v2026.9.24`. */
export const PREVIEW_BRANCH = "release/preview";
export const PREVIEW_FILE = ".github/preview.txt";
export const NIGHTLY_TAG = "nightly";
const root = fileURLToPath(new URL("..", import.meta.url));

/** "owner/name": the run's own repository in Actions, else package.json's `repository` (as app/vite.config.ts reads it). */
function repoName(): string {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const { repository } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { repository?: string };
  return (repository ?? "")
    .replace(/^github:/, "")
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/\.git$/, "");
}

/** The line the Windows and Linux PR and a release carrying their files open with while those builds are unconfirmed (plan 014 R12). */
export const previewLine = (repo: string): string =>
  `**Windows and Linux are a preview:** built and tested in CI, not yet tried on real machines. Report what you find at https://github.com/${repo}/issues.`;

/** The UTC day as a stable's middle number: month then two-digit day, October 11 → "1011", January 1 → "101". */
export const dayNumber = (d: Date): string => `${d.getUTCMonth() + 1}${String(d.getUTCDate()).padStart(2, "0")}`;
/**
 * `YYYY.MMDD.N`: three integers (semver, macOS bundle versions, Cargo, and Windows installers' 65535 cap per part),
 * and newer than every `YYYY.M.D` stable before it, since a month and day (101 to 1231) outnumber a month (1 to 12).
 */
export const stableVersion = (d: Date, n: number): string => `${d.getUTCFullYear()}.${dayNumber(d)}.${n}`;
export const isStableVersion = (v: string): boolean => /^\d{4}\.(?:[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\.\d+$/.test(v);
export const isNightlyVersion = (v: string): boolean => /^\d+\.\d+\.\d+-nightly\.[0-9a-f]{7,40}$/.test(v);

const byVersion = (a: string, b: string) => {
  const [x, y] = [parseVersion(a)!, parseVersion(b)!];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

/** The newest stable among the tags (or the Mac's releases, as `v…`), as a version without the `v`; null when nothing has shipped. */
export function latestStable(tags: string[]): string | null {
  const stable = tags.filter((t) => /^v\d+\.\d+\.\d+$/.test(t)).sort(byVersion);
  return stable.length ? stable[stable.length - 1].slice(1) : null;
}

/** The number the next stable gets: today's, counting on from today's stables among `tags` (0 when there are none). */
export function nextStable(today: Date, tags: string[]): string {
  const prefix = `v${today.getUTCFullYear()}.${dayNumber(today)}.`;
  const taken = tags.filter((t) => t.startsWith(prefix) && /^\d+$/.test(t.slice(prefix.length))).map((t) => Number(t.slice(prefix.length)));
  return stableVersion(today, taken.length ? Math.max(...taken) + 1 : 0);
}

/** A nightly: the stable it leads up to, and the merge that built it, so it sorts after the last stable and before the next. */
export const nightlyVersion = (today: Date, tags: string[], sha: string): string => `${nextStable(today, tags)}-nightly.${sha.slice(0, 7)}`;

const STABLE_TAG = /^v\d+\.\d+\.\d+$/;
const stablesIn = (tags: string[]): string[] => tags.filter((t) => STABLE_TAG.test(t)).map((t) => t.slice(1));

/**
 * What a run does, on a push to main. The release PR landing is recognised by the push changing RELEASE_FILE
 * (`releaseMerged`): a stable, numbered when it is built. The Windows and Linux PR landing is recognised by the push
 * changing PREVIEW_FILE (`previewMerged`, the tag it names): a preview, whose files go on that stable when it exists
 * and nowhere when it does not. Everything else with commits since the last stable is a nightly; nothing new is
 * nothing to do. `shipped` is the stables the Mac has: releases with a `.dmg` (by default every stable tag).
 */
export function plan({
  today,
  sha,
  tags,
  shipped = stablesIn(tags),
  commitsSinceStable,
  releaseMerged = false,
  previewMerged = null,
}: {
  today: Date;
  sha: string;
  tags: string[];
  shipped?: string[];
  commitsSinceStable: number;
  releaseMerged?: boolean;
  previewMerged?: string | null;
}): Plan {
  const latest = latestStable(shipped.map((v) => `v${v}`));
  const nextPreview = latest ?? "";
  const marker = previewMerged?.trim() ?? "";
  if (STABLE_TAG.test(marker)) {
    if (tags.includes(marker))
      return { kind: "preview", version: marker.slice(1), nextPreview, reason: `the Windows and Linux PR for ${marker} landed; its files join that release` };
    return { kind: "none", version: "", nextPreview, reason: `the Windows and Linux PR named ${marker}, which has no release; nothing is built` };
  }
  if (releaseMerged)
    return { kind: "stable", version: nextStable(today, tags), nextPreview, reason: "the release PR landed; the build numbers the stable when it starts" };
  if (commitsSinceStable === 0) return { kind: "none", version: latest ?? "", nextPreview, reason: "nothing since the last stable" };
  return {
    kind: "nightly",
    version: nightlyVersion(today, tags, sha),
    nextPreview,
    reason: `${commitsSinceStable} commit${commitsSinceStable === 1 ? "" : "s"} since ${latest === null ? "the beginning" : `v${latest}`}`,
  };
}

export interface Commit {
  sha: string;
  subject: string;
  body: string;
}

const TRAILER = /^(Co-Authored-By|Signed-off-by|Reviewed-by|Co-authored-by):/i;

/** The commits that are changes, not the release PR's or the Windows and Linux PR's own (`release: …`). */
export const shipping = (commits: Commit[]): Commit[] => commits.filter((c) => !c.subject.startsWith("release: "));

/** Release notes: one entry per commit since the last stable, newest first; the release commits themselves and trailers are left out. */
export function releaseNotes(version: string, commits: Commit[]): string {
  const entries = shipping(commits).map((c) => {
    const body = c.body
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => !TRAILER.test(l))
      .join("\n")
      .trim();
    return `- **${c.subject.trim()}** (${c.sha.slice(0, 7)})${
      body
        ? `\n${body
            .split("\n")
            .map((l) => (l ? `  ${l}` : ""))
            .join("\n")}`
        : ""
    }`;
  });
  return `## ${version}\n\n${entries.length ? entries.join("\n") : "- no changes recorded"}\n`;
}

/** The three version files and the lockfile, set to `version`; returns what changed. */
export function setVersion(version: string, dir = root): string[] {
  if (!isNightlyVersion(version) && !/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a version: ${version}`);
  const edits: Array<[string, RegExp, string]> = [
    ["package.json", /("version":\s*")[^"]*(")/, `$1${version}$2`],
    ["src-tauri/tauri.conf.json", /("version":\s*")[^"]*(")/, `$1${version}$2`],
    ["src-tauri/Cargo.toml", /^(version\s*=\s*")[^"]*(")/m, `$1${version}$2`],
    ["src-tauri/Cargo.lock", /(\nname = "loki"\nversion = ")[^"]*(")/, `$1${version}$2`],
  ];
  const changed: string[] = [];
  for (const [file, re, to] of edits) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    const before = readFileSync(path, "utf8");
    if (!re.test(before)) throw new Error(`${file}: no version field to set`);
    const after = before.replace(re, to);
    if (after !== before) {
      writeFileSync(path, after);
      changed.push(file);
    }
  }
  return changed;
}

// --- the command line -------------------------------------------------------------------------------------

const run = (cmd: string, args: string[], input?: string): string =>
  execFileSync(cmd, args, { cwd: root, encoding: "utf8", input, stdio: ["pipe", "pipe", "inherit"] }).trim();
const git = (...args: string[]) => run("git", args);
const gh = (...args: string[]) => run("gh", args);

function tags(): string[] {
  return git("tag", "--list").split("\n").filter(Boolean);
}
/** The stables the Mac has shipped: the versions of the releases carrying a `.dmg`, from GitHub (the tags cannot tell). */
let shippedCache: string[] | null = null;
function shipped(): string[] {
  shippedCache ??= stablesIn(
    gh(
      "api",
      "--paginate",
      `repos/${repoName()}/releases?per_page=100`,
      "--jq",
      '.[] | select(.draft | not) | select(any(.assets[]; .name | endswith(".dmg"))) | .tag_name',
    ).split("\n"),
  );
  return shippedCache;
}
/** The last stable the Mac shipped, which the notes and the nightly count from. */
const lastStable = (): string | null => latestStable(shipped().map((v) => `v${v}`));
function commitsSince(tag: string | null, head = "HEAD"): Commit[] {
  const range = tag ? `v${tag}..${head}` : head;
  const raw = git("log", range, "--no-merges", "--format=%H%x00%s%x00%b%x1e");
  return raw
    .split("\x1e")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [sha, subject, body] = r.split("\x00");
      return { sha, subject, body: body ?? "" };
    });
}
function output(kv: Record<string, string>): void {
  const lines = Object.entries(kv).map(([k, v]) => `${k}=${v}`);
  console.log(lines.join("\n"));
  if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`, { flag: "a" });
}

/** Whether HEAD's own change touched `file`: the push is that PR's merge. */
function changedAtHead(file: string): boolean {
  try {
    return git("diff", "--name-only", "HEAD^", "HEAD", "--", file) !== "";
  } catch {
    return false; // no parent
  }
}

/** The tag PREVIEW_FILE names at HEAD when HEAD's own change touched it (the Windows and Linux PR's merge), else null. */
function previewMergedAtHead(): string | null {
  if (!changedAtHead(PREVIEW_FILE)) return null;
  try {
    return git("show", `HEAD:${PREVIEW_FILE}`) || null;
  } catch {
    return null; // the file was removed
  }
}

function cmdPlan(): void {
  // Only a push is a merge; a manual run refreshes the two PRs and ships nothing.
  const pushed = (process.env.GITHUB_EVENT_NAME ?? "push") === "push";
  const p = plan({
    today: new Date(),
    sha: git("rev-parse", "HEAD"),
    tags: tags(),
    shipped: shipped(),
    commitsSinceStable: shipping(commitsSince(lastStable())).length,
    releaseMerged: pushed && changedAtHead(RELEASE_FILE),
    previewMerged: pushed ? previewMergedAtHead() : null,
  });
  console.error(`release: ${p.kind} — ${p.reason}`);
  output({ kind: p.kind, version: p.version, preview: p.nextPreview });
}

/**
 * The number this build gets, from the tags as they are when it starts. Stable builds run one at a time, so a stable
 * queued behind another sees its tag and takes the next number: two release merges in a day make .0 and .1.
 */
function cmdVersion(kind: string, sha: string): string {
  git("fetch", "--tags", "--force", "--quiet", "origin");
  if (kind === "stable") return nextStable(new Date(), tags());
  if (kind === "nightly") return nightlyVersion(new Date(), tags(), sha);
  throw new Error(`version: kind is stable or nightly, not ${kind}`);
}

function cmdNotes(version: string): string {
  return releaseNotes(version, commitsSince(lastStable()));
}

/** The release PR's title, body and the file its one commit writes. */
export function releasePr({ notes, mainSha, ifMergedNow }: { notes: string; mainSha: string; ifMergedNow: string }): {
  title: string;
  body: string;
  marker: string;
} {
  return {
    title: "release: the next stable",
    marker: `${mainSha}\n`,
    body: [
      `Merging this ships **the next stable of loki**: the tag, the universal \`.dmg\`, the published release and the Homebrew cask, from one workflow run. Its number is decided when it is built, \`YYYY.MMDD.N\` — the UTC day, then that day's count from 0 — so merged now it would be **${ifMergedNow}**. Windows and Linux follow with their own PR once it is out.`,
      "",
      `This PR is rebuilt from \`main\` on every merge; its one commit writes the main it was built from to \`${RELEASE_FILE}\`. Do not push to it; anything that should ship goes through an ordinary PR.`,
      "",
      notes.replace(/^## .*\n\n/, ""),
    ].join("\n"),
  };
}

/** The one release PR: branch release/next rebuilt from main with its marker, force-pushed; created once, then edited; closed when nothing waits to ship. */
function cmdReleasePr(): void {
  git("fetch", "origin", "main", "--quiet");
  const open = gh("pr", "list", "--head", RELEASE_BRANCH, "--base", "main", "--state", "open", "--json", "number", "--jq", ".[0].number // empty");
  const pending = shipping(commitsSince(lastStable(), "origin/main"));
  if (pending.length === 0) {
    if (open) gh("pr", "close", open, "--comment", "Nothing has merged since the last stable.");
    return console.error(`release: nothing since the last stable${open ? `; PR #${open} closed` : ""}`);
  }
  const mainSha = git("rev-parse", "origin/main");
  const ifMergedNow = nextStable(new Date(), tags());
  const { title, body, marker } = releasePr({ notes: releaseNotes(ifMergedNow, pending), mainSha, ifMergedNow });
  git("checkout", "-B", RELEASE_BRANCH, "origin/main");
  writeFileSync(join(root, RELEASE_FILE), marker);
  git("add", RELEASE_FILE);
  git(
    "commit",
    "--quiet",
    "-m",
    `${title}\n\nThe release PR: merge it and main ships as the next stable, numbered at the build. Rebuilt from main on every merge; do not edit.`,
  );
  git("push", "--force", "--quiet", "origin", `HEAD:refs/heads/${RELEASE_BRANCH}`);
  if (open) gh("pr", "edit", open, "--title", title, "--body", body);
  else gh("pr", "create", "--base", "main", "--head", RELEASE_BRANCH, "--title", title, "--body", body);
  console.error(`release: PR ${open ? `#${open} refreshed` : "opened"}; merged now it would be ${ifMergedNow}`);
}

/** A release's notes, or null when there is no such release (`gh release view` fails). */
function releaseBody(tag: string, gh: (...args: string[]) => string): string | null {
  try {
    return gh("release", "view", tag, "--json", "body", "--jq", ".body");
  } catch {
    return null;
  }
}

/**
 * Publish: a stable gets its own tag at the merge and its release, marked latest — never another release's, so a
 * number some earlier run already took fails loudly rather than mixing two builds' files; a nightly replaces the
 * rolling one, only now that the build is in hand. The Mac's files only.
 */
export function publish({
  kind,
  version,
  files,
  sha,
  notesFile,
  gh,
}: {
  kind: string;
  version: string;
  files: string[];
  sha: string;
  notesFile: string;
  repo?: string;
  gh: (...args: string[]) => string;
}): void {
  if (!files.length) throw new Error("publish: no files");
  if (kind === "stable") {
    if (!isStableVersion(version)) throw new Error(`a stable looks like 2026.1011.0, not ${version}`);
    const tag = `v${version}`;
    if (releaseBody(tag, gh) !== null) throw new Error(`${tag} already exists: this build's number was taken; re-run the job to number it again`);
    gh("release", "create", tag, "--target", sha, "--title", `loki ${version}`, "--notes-file", notesFile, "--latest", ...files);
  } else if (kind === "nightly") {
    if (!isNightlyVersion(version)) throw new Error(`a nightly version looks like 2026.1011.1-nightly.a96ee85, not ${version}`);
    try {
      gh("release", "delete", NIGHTLY_TAG, "--yes", "--cleanup-tag");
    } catch {
      // no nightly yet
    }
    gh("release", "create", NIGHTLY_TAG, "--target", sha, "--prerelease", "--title", `loki ${version}`, "--notes-file", notesFile, ...files);
  } else throw new Error(`publish: kind is stable or nightly, not ${kind}`);
}

function cmdPublish(kind: string, version: string, files: string[]): void {
  if (!files.length) throw new Error("publish: no files");
  const notesFile = join(root, ".release-notes.md");
  writeFileSync(notesFile, cmdNotes(version).replace(/^## .*\n\n/, ""));
  publish({ kind, version, files, sha: git("rev-parse", "HEAD"), notesFile, gh });
  console.error(`release: published ${kind} ${version}`);
}

// --- the Windows and Linux PR ------------------------------------------------------------------------------

/** Whether a release's asset names include every preview file: the -setup.exe, the AppImage and the .deb. */
export const hasPreviewFiles = (assets: string[]): boolean =>
  ["_x64-setup.exe", "_amd64.AppImage", "_amd64.deb"].every((s) => assets.some((a) => a.endsWith(s)));

/**
 * What the Windows and Linux PR should do now, from the stable it targets, that release's asset names (null: no such
 * release, so nothing to put files on) and the tag main's PREVIEW_FILE records: open (or refresh) it while the release
 * lacks the files, close it once they are there or when there is no release, and wait when main already records this
 * version — its merge is building, or failed and wants a re-run, and a PR writing the same marker would change nothing.
 */
export function previewAction({ version, assets, marker }: { version: string; assets: string[] | null; marker: string }): "open" | "close" | "wait" {
  if (assets === null || hasPreviewFiles(assets)) return "close";
  return marker.trim() === `v${version}` ? "wait" : "open";
}

/** The Windows and Linux PR's title, body and the marker its one commit writes. */
export function previewPr(version: string, repo: string): { title: string; body: string; marker: string } {
  const tag = `v${version}`;
  return {
    title: `release: Windows and Linux ${version}`,
    marker: `${tag}\n`,
    body: [
      `**Windows and Linux ${version}.** Merging this builds \`main\` as it is at the merge on Windows and Linux and publishes the files on the ${tag} release:`,
      "",
      `1. \`loki_${version}_x64-setup.exe\`, the NSIS installer (64-bit Windows 10 or 11)`,
      `2. \`loki_${version}_amd64.AppImage\` and \`loki_${version}_amd64.deb\`, built on Ubuntu 22.04`,
      "",
      `The files join the Mac's stable \`${tag}\`, built from \`main\` as it is when this merges, so anything merged since that stable is in them too. The merge makes no nightly and touches neither the \`.dmg\` nor the casks.`,
      "",
      "The files are unsigned previews: SmartScreen asks for **More info → Run anyway** once, and the AppImage needs `chmod +x`.",
      "",
      previewLine(repo),
      "",
      `Its one commit records the tag in \`${PREVIEW_FILE}\`. It is rebuilt from \`main\` on every merge, opened when a stable ships without these files and closed once ${tag} has them; do not push to it.`,
    ].join("\n"),
  };
}

/**
 * Put the Windows and Linux files on the stable `tag`, replacing any from an earlier run, and the preview line on its
 * notes once. The release must exist: Windows and Linux never make one of their own.
 */
export function attachPreview({ tag, files, repo, gh }: { tag: string; files: string[]; repo: string; gh: (...args: string[]) => string }): void {
  if (!files.length) throw new Error("attach: no files");
  if (!STABLE_TAG.test(tag)) throw new Error(`attach: a stable tag like v2026.1011.0, not ${tag}`);
  const body = releaseBody(tag, gh);
  if (body === null) throw new Error(`attach: ${tag} has no release to put the Windows and Linux files on`);
  const line = previewLine(repo);
  gh("release", "upload", tag, ...files, "--clobber");
  if (!body.includes(line)) gh("release", "edit", tag, "--notes", `${line}\n\n${body}`.trimEnd());
}

/** The one Windows and Linux PR: branch release/preview rebuilt from main with the marker, force-pushed; the PR created once, then edited, closed once the release has the files. */
function cmdPreviewPr(version: string): void {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`the Windows and Linux PR targets a stable, not ${version || "nothing"}`);
  const tag = `v${version}`;
  let assets: string[] | null = null;
  try {
    assets = gh("release", "view", tag, "--json", "assets", "--jq", ".assets[].name").split("\n").filter(Boolean);
  } catch {
    // no such release: nothing to put files on
  }
  git("fetch", "origin", "main", "--quiet");
  let marker = "";
  try {
    marker = git("show", `origin/main:${PREVIEW_FILE}`);
  } catch {
    // no Windows and Linux PR merged yet
  }
  const action = previewAction({ version, assets, marker });
  const open = gh("pr", "list", "--head", PREVIEW_BRANCH, "--base", "main", "--state", "open", "--json", "number", "--jq", ".[0].number // empty");
  if (action === "close") {
    const why = assets === null ? `${tag} has no release to put files on` : `${tag} already has its Windows and Linux files`;
    if (open) gh("pr", "close", open, "--comment", `${why}.`);
    return console.error(`release: ${why}${open ? `; PR #${open} closed` : ""}`);
  }
  if (action === "wait")
    return console.error(
      `release: the Windows and Linux PR for ${tag} is merged but its files are not on the release yet — it is building, or re-run its failed jobs`,
    );
  const { title, body, marker: text } = previewPr(version, repoName());
  git("checkout", "-B", PREVIEW_BRANCH, "origin/main");
  writeFileSync(join(root, PREVIEW_FILE), text);
  git("add", PREVIEW_FILE);
  git(
    "commit",
    "--quiet",
    "-m",
    `${title}\n\nThe Windows and Linux PR: merge it and main is built on Windows and Linux and published on ${tag}. Rebuilt from main on every merge; do not edit.`,
  );
  git("push", "--force", "--quiet", "origin", `HEAD:refs/heads/${PREVIEW_BRANCH}`);
  if (open) gh("pr", "edit", open, "--title", title, "--body", body);
  else gh("pr", "create", "--base", "main", "--head", PREVIEW_BRANCH, "--title", title, "--body", body);
  console.error(`release: Windows and Linux PR ${open ? `#${open} refreshed` : "opened"} for ${tag}`);
}

function cmdAttach(tag: string, files: string[]): void {
  attachPreview({ tag, files, repo: repoName(), gh });
  console.error(`release: put ${files.length} Windows and Linux file${files.length === 1 ? "" : "s"} on ${tag}`);
}

// Run as a script (`npm run release -- …`), not imported by its test.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    switch (cmd) {
      case "plan":
        cmdPlan();
        break;
      case "version":
        console.log(cmdVersion(args[0] ?? "", args[1] ?? git("rev-parse", "HEAD")));
        break;
      case "set":
        console.log(setVersion(args[0] ?? "").join("\n"));
        break;
      case "notes":
        process.stdout.write(cmdNotes(args[0] ?? nextStable(new Date(), tags())));
        break;
      case "release-pr":
        cmdReleasePr();
        break;
      case "publish":
        cmdPublish(args[0] ?? "", args[1] ?? "", args.slice(2));
        break;
      case "preview-pr":
        cmdPreviewPr(args[0] ?? lastStable() ?? "");
        break;
      case "attach":
        cmdAttach(args[0] ?? "", args.slice(1));
        break;
      default:
        console.error(
          "usage: npm run release -- plan | version <stable|nightly> [sha] | set <version> | notes [version] | release-pr | publish <stable|nightly> <version> <dmg…> | preview-pr [version] | attach <tag> <files…>",
        );
        process.exit(2);
    }
  } catch (err) {
    console.error(`release: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
