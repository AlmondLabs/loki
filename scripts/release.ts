// Release management, date-based (docs/plans/2026-09-17-011-feat-loki-release-channels-plan.md, docs/RELEASING.md).
//
// The calendar is the version. A stable is `YYYY.M.D` (UTC) of the day its release PR is merged; a nightly is
// `YYYY.M.D-nightly.<sha>` of the merge that built it. The releases are the source of truth: the newest `vYYYY.M.D`
// release with a `.dmg` is the current stable, and the three version files hold that same number between releases —
// only the release PR moves them. `.github/workflows/release.yml` runs this on every push to main, at midnight UTC,
// and by hand:
//
//   bun scripts/release.ts plan                 what this run should do: stable | nightly | repush | preview | none
//   bun scripts/release.ts set <version>        stamp the three version files (+ Cargo.lock), uncommitted
//   bun scripts/release.ts notes <version>      release notes from the commits since the last stable
//   bun scripts/release.ts release-pr <version> create or refresh the one release PR (branch release/next)
//   bun scripts/release.ts publish <kind> <version> <dmg…>   the GitHub release: vX (new, or onto Windows and Linux's), or the rolling nightly
//   bun scripts/release.ts preview-pr <version> create, refresh or close the Windows and Linux PR (branch release/preview)
//   bun scripts/release.ts attach <tag> <files…> the Windows and Linux files onto vX, creating it when the Mac has not shipped it yet
//
// Windows and Linux are previews and only ever stables (plan 014 R12). Their PR proposes the same day's version as
// the release PR and is rebuilt from main alongside it; whichever of the two is merged first creates `vYYYY.M.D`,
// and the other adds its files to it. Nightlies are the Mac's alone.
//
// One stable a day: a version has three integer slots and the date uses them all. The release PR's number goes
// stale at midnight, so the workflow refreshes it daily, and the release merge recomputes: files that disagree
// with today are not tagged, the PR is force-pushed with the right number and asks for one more merge.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseVersion } from "../core/version.ts";

export type Kind = "stable" | "nightly" | "repush" | "preview" | "none";
export interface Plan {
  kind: Kind;
  /** What to build and publish (stable / nightly / preview), or what the release PR should now propose (repush). */
  version: string;
  /** The version the release PR proposes after this run. */
  nextStable: string;
  /** The version the Windows and Linux PR proposes after this run: today's, the release PR's own unless the Mac already shipped today. */
  nextPreview: string;
  reason: string;
}

export const RELEASE_BRANCH = "release/next";
/** The Windows and Linux PR's branch, and the one file its commit changes: the tag its files go on, `v2026.9.24`. */
export const PREVIEW_BRANCH = "release/preview";
export const PREVIEW_FILE = ".github/preview.txt";
export const NIGHTLY_TAG = "nightly";
const root = fileURLToPath(new URL("..", import.meta.url));

/** "owner/name": the run's own repository in Actions, else package.json's `repository` (as app/vite.config.ts reads it). */
function repoName(): string {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const { repository } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { repository?: string };
  return (repository ?? "").replace(/^github:/, "").replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
}

/** The line the Windows and Linux PR and a release carrying their files open with while those builds are unconfirmed (plan 014 R12). */
export const previewLine = (repo: string): string =>
  `**Windows and Linux are a preview:** built and tested in CI, not yet tried on real machines. Report what you find at https://github.com/${repo}/issues.`;

/** `YYYY.M.D` in UTC, no leading zeros: valid semver, a valid macOS bundle version, and Homebrew orders it. */
export const dateVersion = (d: Date): string => `${d.getUTCFullYear()}.${d.getUTCMonth() + 1}.${d.getUTCDate()}`;
export const isDateVersion = (v: string): boolean => /^\d{4}\.\d{1,2}\.\d{1,2}$/.test(v);
export const nightlyVersion = (d: Date, sha: string): string => `${dateVersion(d)}-nightly.${sha.slice(0, 7)}`;
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

/** The date the next stable gets: today, unless today already has one (among `tags`: the Mac's releases) — then tomorrow. */
export function nextStable(today: Date, tags: string[]): string {
  const v = dateVersion(today);
  if (!tags.includes(`v${v}`)) return v;
  const tomorrow = new Date(today);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return dateVersion(tomorrow);
}

const STABLE_TAG = /^v\d+\.\d+\.\d+$/;
const stablesIn = (tags: string[]): string[] => tags.filter((t) => STABLE_TAG.test(t)).map((t) => t.slice(1));

/**
 * What a run should do. `shipped` is the stables the Mac has: releases with a `.dmg` (by default every stable tag).
 * A tag alone is not enough, because merging the Windows and Linux PR first creates the day's tag and release
 * without one. The Windows and Linux PR landing is recognised by its marker: the push changed PREVIEW_FILE
 * (`previewMerged`), and it is a preview of that version whatever the version files say. A release PR landing is
 * recognised by the files: they name a version the Mac has not shipped. Everything else with commits since the
 * last stable is a nightly; nothing new is nothing to do.
 */
export function plan({ today, sha, fileVersion, tags, shipped = stablesIn(tags), commitsSinceStable, previewMerged = null }: { today: Date; sha: string; fileVersion: string; tags: string[]; shipped?: string[]; commitsSinceStable: number; previewMerged?: string | null }): Plan {
  const macTags = shipped.map((v) => `v${v}`);
  const latest = latestStable(macTags);
  const today_ = dateVersion(today);
  const next = { nextStable: nextStable(today, macTags), nextPreview: today_ };
  const marker = previewMerged?.trim() ?? "";
  if (STABLE_TAG.test(marker)) {
    // today's, or an older day's release that exists (the Mac shipped it): the files go on it; an older day with no release waits for today
    if (marker === `v${today_}` || tags.includes(marker)) return { kind: "preview", version: marker.slice(1), ...next, reason: `the Windows and Linux PR for ${marker} landed${tags.includes(marker) ? "; its files join that release" : "; it creates the release"}` };
    return { kind: "repush", version: next.nextStable, ...next, reason: `the Windows and Linux PR proposed ${marker} but today is ${today_} — it now proposes v${today_}` };
  }
  if (latest !== null && !shipped.includes(fileVersion)) {
    if (fileVersion === today_) return { kind: "stable", version: fileVersion, ...next, reason: `the release PR for ${fileVersion} landed${tags.includes(`v${fileVersion}`) ? "; its release has Windows and Linux already" : ""}` };
    const why = shipped.includes(today_) ? `${today_} already shipped and it is one stable a day, so ${fileVersion} waits for its day` : `the release PR proposed ${fileVersion} but today is ${today_}`;
    return { kind: "repush", version: next.nextStable, ...next, reason: `${why} — the release PR now proposes ${next.nextStable}` };
  }
  if (commitsSinceStable === 0) return { kind: "none", version: latest ?? "", ...next, reason: "nothing since the last stable" };
  return { kind: "nightly", version: nightlyVersion(today, sha), ...next, reason: `${commitsSinceStable} commit${commitsSinceStable === 1 ? "" : "s"} since ${latest === null ? "the beginning" : `v${latest}`}` };
}

export interface Commit {
  sha: string;
  subject: string;
  body: string;
}

const TRAILER = /^(Co-Authored-By|Signed-off-by|Reviewed-by|Co-authored-by):/i;

/** The commits that are changes, not the release PR's or the Windows and Linux PR's own (`release: …`). */
export const shipping = (commits: Commit[]): Commit[] => commits.filter((c) => !/^release: /.test(c.subject));

/** Release notes: one entry per commit since the last stable, newest first; the release commits themselves and trailers are left out. */
export function releaseNotes(version: string, commits: Commit[]): string {
  const entries = shipping(commits)
    .map((c) => {
      const body = c.body
        .split("\n")
        .map((l) => l.trimEnd())
        .filter((l) => !TRAILER.test(l))
        .join("\n")
        .trim();
      return `- **${c.subject.trim()}** (${c.sha.slice(0, 7)})${body ? `\n${body.split("\n").map((l) => (l ? `  ${l}` : "")).join("\n")}` : ""}`;
    });
  return `## ${version}\n\n${entries.length ? entries.join("\n") : "- no changes recorded"}\n`;
}

/** The three version files and the lockfile, set to `version`; returns what changed. */
export function setVersion(version: string, dir = root): string[] {
  if (!isDateVersion(version) && !isNightlyVersion(version) && !/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a version: ${version}`);
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

/** CHANGELOG.md with this version's section on top (replacing an existing section of the same version). */
export function withChangelog(existing: string, section: string): string {
  const version = section.match(/^## (\S+)/)?.[1];
  const stripped = version ? existing.replace(new RegExp(`## ${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n[\\s\\S]*?(?=\\n## |$)`), "").trimStart() : existing.trimStart();
  const head = "# Changelog\n\nEvery stable, newest first. The version is the day it shipped (UTC); nightlies are not listed.\n\n";
  const rest = stripped.startsWith("# Changelog") ? stripped.slice(stripped.indexOf("\n## ") === -1 ? stripped.length : stripped.indexOf("\n## ") + 1) : stripped;
  return `${head}${section.trim()}\n${rest ? `\n${rest.trimStart()}` : ""}`;
}

// --- the command line -------------------------------------------------------------------------------------

const run = (cmd: string, args: string[], input?: string): string => execFileSync(cmd, args, { cwd: root, encoding: "utf8", input, stdio: ["pipe", "pipe", "inherit"] }).trim();
const git = (...args: string[]) => run("git", args);
const gh = (...args: string[]) => run("gh", args);

function tags(): string[] {
  return git("tag", "--list").split("\n").filter(Boolean);
}
/** The stables the Mac has shipped: the versions of the releases carrying a `.dmg`, from GitHub (the tags cannot tell). */
let shippedCache: string[] | null = null;
function shipped(): string[] {
  shippedCache ??= stablesIn(gh("api", "--paginate", `repos/${repoName()}/releases?per_page=100`, "--jq", '.[] | select(.draft | not) | select(any(.assets[]; .name | endswith(".dmg"))) | .tag_name').split("\n"));
  return shippedCache;
}
/** The last stable the Mac shipped, which the notes and the nightly count from. */
const lastStable = (): string | null => latestStable(shipped().map((v) => `v${v}`));
function fileVersion(): string {
  return (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
}
function commitsSince(tag: string | null): Commit[] {
  const range = tag ? `v${tag}..HEAD` : "HEAD";
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

/** The tag PREVIEW_FILE names at HEAD when HEAD's own change touched it (the Windows and Linux PR's merge), else null. */
function previewMergedAtHead(): string | null {
  try {
    if (!git("diff", "--name-only", "HEAD^", "HEAD", "--", PREVIEW_FILE)) return null;
    return git("show", `HEAD:${PREVIEW_FILE}`) || null;
  } catch {
    return null; // no parent, or the file was removed
  }
}

function cmdPlan(): void {
  // Only a push is a merge; the midnight run and a manual one must not rebuild the last preview again.
  const pushed = (process.env.GITHUB_EVENT_NAME ?? "push") === "push";
  const p = plan({ today: new Date(), sha: git("rev-parse", "HEAD"), fileVersion: fileVersion(), tags: tags(), shipped: shipped(), commitsSinceStable: shipping(commitsSince(lastStable())).length, previewMerged: pushed ? previewMergedAtHead() : null });
  console.error(`release: ${p.kind} — ${p.reason}`);
  output({ kind: p.kind, version: p.version, next: p.nextStable, preview: p.nextPreview });
}

function cmdNotes(version: string): string {
  return releaseNotes(version, commitsSince(lastStable()));
}

/** The one release PR: branch release/next rebuilt from main with the bump and the changelog, force-pushed; the PR created once, then edited. */
function cmdReleasePr(version: string): void {
  if (!isDateVersion(version)) throw new Error(`a release PR proposes a date version, not ${version}`);
  const notes = cmdNotes(version);
  git("fetch", "origin", "main", "--quiet");
  git("checkout", "-B", RELEASE_BRANCH, "origin/main");
  setVersion(version);
  const changelog = join(root, "CHANGELOG.md");
  writeFileSync(changelog, withChangelog(existsSync(changelog) ? readFileSync(changelog, "utf8") : "", notes));
  git("add", "package.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "CHANGELOG.md");
  const title = `release: ${version}`;
  git("commit", "--quiet", "-m", `${title}\n\nThe release PR: merge it and this becomes stable ${version} (UTC). Rebuilt from main on every merge; do not edit.`);
  git("push", "--force", "--quiet", "origin", `HEAD:refs/heads/${RELEASE_BRANCH}`);
  const body = [
    `Merging this ships **loki ${version}**: the tag, the universal \`.dmg\`, the published release and the Homebrew cask, all from one workflow run. Windows and Linux have their own PR for the same version; whichever merges first creates the release, and the other adds its files to it.`,
    "",
    "This PR is rebuilt from `main` on every merge and at midnight UTC, so its number is today's date and its notes are everything since the last stable. Do not push to it; anything that should ship goes through an ordinary PR.",
    "",
    notes.replace(/^## .*\n\n/, ""),
  ].join("\n");
  const open = gh("pr", "list", "--head", RELEASE_BRANCH, "--base", "main", "--state", "open", "--json", "number", "--jq", ".[0].number // empty");
  if (open) gh("pr", "edit", open, "--title", title, "--body", body);
  else gh("pr", "create", "--base", "main", "--head", RELEASE_BRANCH, "--title", title, "--body", body);
  console.error(`release: PR ${open ? `#${open} refreshed` : "opened"} for ${version}`);
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
 * Create `tag`'s release, or, when the other system's merge made it first, hand back its notes to join it. The two
 * release PRs run in separate queues (sharing one would let GitHub drop a waiting Mac stable), so both may find no
 * release and race to create it: the loser's create fails, and it joins the release the winner made.
 */
function createOrJoin(tag: string, create: () => void, gh: (...args: string[]) => string): string | null {
  const existing = releaseBody(tag, gh);
  if (existing !== null) return existing;
  try {
    create();
    return null;
  } catch (err) {
    const made = releaseBody(tag, gh);
    if (made === null) throw err;
    return made;
  }
}

/**
 * Publish: a stable gets its own tag and release, or, when the Windows and Linux PR merged first and made them,
 * its `.dmg` goes onto that release, which becomes latest with the full notes (the tag stays at that merge); a
 * nightly replaces the rolling one, only now that the build is in hand. The Mac's files only.
 */
export function publish({ kind, version, files, sha, notesFile, repo, gh }: { kind: string; version: string; files: string[]; sha: string; notesFile: string; repo: string; gh: (...args: string[]) => string }): void {
  if (!files.length) throw new Error("publish: no files");
  if (kind === "stable") {
    if (!isDateVersion(version)) throw new Error(`a stable is a date version, not ${version}`);
    const tag = `v${version}`;
    if (createOrJoin(tag, () => void gh("release", "create", tag, "--target", sha, "--title", `loki ${version}`, "--notes-file", notesFile, "--latest", ...files), gh) === null) return;
    gh("release", "upload", tag, ...files, "--clobber");
    gh("release", "edit", tag, "--latest");
    gh("release", "edit", tag, "--notes", `${previewLine(repo)}\n\n${readFileSync(notesFile, "utf8")}`.trimEnd());
  } else if (kind === "nightly") {
    if (!isNightlyVersion(version)) throw new Error(`a nightly version looks like 2026.9.28-nightly.a96ee85, not ${version}`);
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
  publish({ kind, version, files, sha: git("rev-parse", "HEAD"), notesFile, repo: repoName(), gh });
  console.error(`release: published ${kind} ${version}`);
}

// --- the Windows and Linux PR ------------------------------------------------------------------------------

/** Whether a release's asset names include every preview file: the -setup.exe, the AppImage and the .deb. */
export const hasPreviewFiles = (assets: string[]): boolean => ["_x64-setup.exe", "_amd64.AppImage", "_amd64.deb"].every((s) => assets.some((a) => a.endsWith(s)));

/**
 * What the Windows and Linux PR should do now, from its version, that release's asset names (null: no release yet,
 * merging creates it) and the tag main's PREVIEW_FILE records: open (or refresh) it while the release lacks the
 * files, close it once they are there, and wait when main already records this version — its merge is building,
 * or failed and wants a re-run, and a PR writing the same marker would have nothing to change.
 */
export function previewAction({ version, assets, marker }: { version: string; assets: string[] | null; marker: string }): "open" | "close" | "wait" {
  if (assets !== null && hasPreviewFiles(assets)) return "close";
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
      `It shares \`${tag}\` with the Mac's release PR (\`release: ${version}\`): whichever merges first creates the release, and the other adds its files to it. Merged first, this makes the tag at its merge and a release that is not marked latest, so the Mac's update check and the Homebrew cask keep the last \`.dmg\` until the Mac's PR lands. The merge makes no nightly and touches neither the \`.dmg\` nor the casks.`,
      "",
      "The files are unsigned previews: SmartScreen asks for **More info → Run anyway** once, and the AppImage needs `chmod +x`.",
      "",
      previewLine(repo),
      "",
      `Its one commit records the tag in \`${PREVIEW_FILE}\`. It is rebuilt from \`main\` on every merge and at midnight UTC, like the release PR, and closed once ${tag} has the files; do not push to it.`,
    ].join("\n"),
  };
}

/**
 * Put the Windows and Linux files on `tag`. When its release exists (the Mac merged first) they are uploaded,
 * replacing any from an earlier run, and the preview line goes on its notes once. When it does not (Windows and
 * Linux merged first) this creates the tag at `sha`, the merge, and the release with `notes` and the preview line,
 * not marked latest: GitHub's latest is what the Mac's update check and the cask's livecheck read, and this release
 * has no `.dmg` until the release PR lands.
 */
export function attachPreview({ tag, files, repo, sha, notes, gh }: { tag: string; files: string[]; repo: string; sha: string; notes: string; gh: (...args: string[]) => string }): void {
  if (!files.length) throw new Error("attach: no files");
  if (!STABLE_TAG.test(tag)) throw new Error(`attach: a stable tag like v2026.9.24, not ${tag}`);
  const line = previewLine(repo);
  const body = createOrJoin(tag, () => void gh("release", "create", tag, "--target", sha, "--title", `loki ${tag.slice(1)}`, "--notes", `${line}\n\n${notes}`.trimEnd(), "--latest=false", ...files), gh);
  if (body === null) return;
  gh("release", "upload", tag, ...files, "--clobber");
  if (!body.includes(line)) gh("release", "edit", tag, "--notes", `${line}\n\n${body}`.trimEnd());
}

/** The one Windows and Linux PR: branch release/preview rebuilt from main with the marker, force-pushed; the PR created once, then edited, closed once the release has the files. */
function cmdPreviewPr(version: string): void {
  if (!isDateVersion(version)) throw new Error(`the Windows and Linux PR proposes a date version, not ${version}`);
  const tag = `v${version}`;
  let assets: string[] | null = null;
  try {
    assets = gh("release", "view", tag, "--json", "assets", "--jq", ".assets[].name").split("\n").filter(Boolean);
  } catch {
    // no release for this day yet: merging the PR creates it
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
    if (open) gh("pr", "close", open, "--comment", `${tag} already has its Windows and Linux files.`);
    return console.error(`release: ${tag} has its Windows and Linux files${open ? `; PR #${open} closed` : ""}`);
  }
  if (action === "wait") return console.error(`release: the Windows and Linux PR for ${tag} is merged but its files are not on the release yet — it is building, or re-run its failed jobs`);
  const { title, body, marker: text } = previewPr(version, repoName());
  git("checkout", "-B", PREVIEW_BRANCH, "origin/main");
  writeFileSync(join(root, PREVIEW_FILE), text);
  git("add", PREVIEW_FILE);
  git("commit", "--quiet", "-m", `${title}\n\nThe Windows and Linux PR: merge it and main is built on Windows and Linux and published on ${tag}. Rebuilt from main on every merge; do not edit.`);
  git("push", "--force", "--quiet", "origin", `HEAD:refs/heads/${PREVIEW_BRANCH}`);
  if (open) gh("pr", "edit", open, "--title", title, "--body", body);
  else gh("pr", "create", "--base", "main", "--head", PREVIEW_BRANCH, "--title", title, "--body", body);
  console.error(`release: Windows and Linux PR ${open ? `#${open} refreshed` : "opened"} for ${tag}`);
}

function cmdAttach(tag: string, files: string[]): void {
  attachPreview({ tag, files, repo: repoName(), sha: git("rev-parse", "HEAD"), notes: cmdNotes(tag.slice(1)).replace(/^## .*\n\n/, ""), gh });
  console.error(`release: put ${files.length} Windows and Linux file${files.length === 1 ? "" : "s"} on ${tag}`);
}

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    switch (cmd) {
      case "plan":
        cmdPlan();
        break;
      case "set":
        console.log(setVersion(args[0] ?? "").join("\n"));
        break;
      case "notes":
        process.stdout.write(cmdNotes(args[0] ?? nextStable(new Date(), tags())));
        break;
      case "release-pr":
        cmdReleasePr(args[0] ?? nextStable(new Date(), tags()));
        break;
      case "publish":
        cmdPublish(args[0] ?? "", args[1] ?? "", args.slice(2));
        break;
      case "preview-pr":
        cmdPreviewPr(args[0] ?? dateVersion(new Date()));
        break;
      case "attach":
        cmdAttach(args[0] ?? "", args.slice(1));
        break;
      default:
        console.error("usage: bun scripts/release.ts plan | set <version> | notes [version] | release-pr [version] | publish <stable|nightly> <version> <dmg…> | preview-pr [version] | attach <tag> <files…>");
        process.exit(2);
    }
  } catch (err) {
    console.error(`release: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
