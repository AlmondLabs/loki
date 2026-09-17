// Release management, date-based (docs/plans/2026-09-17-011-feat-loki-release-channels-plan.md, docs/RELEASING.md).
//
// The calendar is the version. A stable is `YYYY.M.D` (UTC) of the day its release PR is merged; a nightly is
// `YYYY.M.D-nightly.<sha>` of the merge that built it. Tags are the source of truth: the newest `vYYYY.M.D` tag
// is the current stable, and the three version files hold that same number between releases — only the release
// PR moves them. `.github/workflows/release.yml` runs this on every push to main, at midnight UTC, and by hand:
//
//   bun scripts/release.ts plan                 what this run should do: stable | nightly | repush | none
//   bun scripts/release.ts set <version>        stamp the three version files (+ Cargo.lock), uncommitted
//   bun scripts/release.ts notes <version>      release notes from the commits since the last stable
//   bun scripts/release.ts release-pr <version> create or refresh the one release PR (branch release/next)
//   bun scripts/release.ts publish <kind> <version> <dmg…>   the GitHub release: a new vX tag, or the rolling nightly
//
// One stable a day: a version has three integer slots and the date uses them all. The release PR's number goes
// stale at midnight, so the workflow refreshes it daily, and the release merge recomputes: files that disagree
// with today are not tagged, the PR is force-pushed with the right number and asks for one more merge.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseVersion } from "../core/version.ts";

export type Kind = "stable" | "nightly" | "repush" | "none";
export interface Plan {
  kind: Kind;
  /** What to build and publish (stable / nightly), or what the release PR should now propose (repush). */
  version: string;
  /** The version the release PR proposes after this run. */
  nextStable: string;
  reason: string;
}

export const RELEASE_BRANCH = "release/next";
export const NIGHTLY_TAG = "nightly";
const root = fileURLToPath(new URL("..", import.meta.url));

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

/** The newest stable among the tags, as a version without the `v`; null when nothing has shipped. */
export function latestStable(tags: string[]): string | null {
  const stable = tags.filter((t) => /^v\d+\.\d+\.\d+$/.test(t)).sort(byVersion);
  return stable.length ? stable[stable.length - 1].slice(1) : null;
}

/** The date the next stable gets: today, unless today already has one — then tomorrow. */
export function nextStable(today: Date, tags: string[]): string {
  const v = dateVersion(today);
  if (!tags.includes(`v${v}`)) return v;
  const tomorrow = new Date(today);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return dateVersion(tomorrow);
}

/**
 * What a run should do. A release PR landing is recognised by the files: they name a version the tags do not
 * have yet. Everything else with commits since the last stable is a nightly; nothing new is nothing to do.
 */
export function plan({ today, sha, fileVersion, tags, commitsSinceStable }: { today: Date; sha: string; fileVersion: string; tags: string[]; commitsSinceStable: number }): Plan {
  const latest = latestStable(tags);
  const next = nextStable(today, tags);
  if (latest !== null && fileVersion !== latest) {
    if (fileVersion === dateVersion(today) && !tags.includes(`v${fileVersion}`)) return { kind: "stable", version: fileVersion, nextStable: next, reason: `the release PR for ${fileVersion} landed` };
    const today_ = dateVersion(today);
    const why = tags.includes(`v${today_}`) ? `${today_} already shipped and it is one stable a day, so ${fileVersion} waits for its day` : `the release PR proposed ${fileVersion} but today is ${today_}`;
    return { kind: "repush", version: next, nextStable: next, reason: `${why} — the release PR now proposes ${next}` };
  }
  if (commitsSinceStable === 0) return { kind: "none", version: latest ?? "", nextStable: next, reason: "nothing since the last stable" };
  return { kind: "nightly", version: nightlyVersion(today, sha), nextStable: next, reason: `${commitsSinceStable} commit${commitsSinceStable === 1 ? "" : "s"} since ${latest === null ? "the beginning" : `v${latest}`}` };
}

export interface Commit {
  sha: string;
  subject: string;
  body: string;
}

const TRAILER = /^(Co-Authored-By|Signed-off-by|Reviewed-by|Co-authored-by):/i;

/** Release notes: one entry per commit since the last stable, newest first; the release commits themselves and trailers are left out. */
export function releaseNotes(version: string, commits: Commit[]): string {
  const entries = commits
    .filter((c) => !/^release: /.test(c.subject))
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

function cmdPlan(): void {
  const t = tags();
  const latest = latestStable(t);
  const p = plan({ today: new Date(), sha: git("rev-parse", "HEAD"), fileVersion: fileVersion(), tags: t, commitsSinceStable: commitsSince(latest).length });
  console.error(`release: ${p.kind} — ${p.reason}`);
  output({ kind: p.kind, version: p.version, next: p.nextStable });
}

function cmdNotes(version: string): string {
  return releaseNotes(version, commitsSince(latestStable(tags())));
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
    `Merging this ships **loki ${version}**: the tag, the universal \`.dmg\`, the published release and the Homebrew cask, all from one workflow run.`,
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

/** Publish: a stable gets its own tag and release; a nightly replaces the rolling one, only now that the build is in hand. */
function cmdPublish(kind: string, version: string, files: string[]): void {
  if (!files.length) throw new Error("publish: no files");
  const notes = cmdNotes(version);
  const notesFile = join(root, ".release-notes.md");
  writeFileSync(notesFile, notes.replace(/^## .*\n\n/, ""));
  const sha = git("rev-parse", "HEAD");
  if (kind === "stable") {
    if (!isDateVersion(version)) throw new Error(`a stable is a date version, not ${version}`);
    gh("release", "create", `v${version}`, "--target", sha, "--title", `loki ${version}`, "--notes-file", notesFile, "--latest", ...files);
  } else if (kind === "nightly") {
    if (!isNightlyVersion(version)) throw new Error(`a nightly version looks like 2026.9.28-nightly.a96ee85, not ${version}`);
    try {
      gh("release", "delete", NIGHTLY_TAG, "--yes", "--cleanup-tag");
    } catch {
      // no nightly yet
    }
    gh("release", "create", NIGHTLY_TAG, "--target", sha, "--prerelease", "--title", `loki ${version}`, "--notes-file", notesFile, ...files);
  } else throw new Error(`publish: kind is stable or nightly, not ${kind}`);
  console.error(`release: published ${kind} ${version}`);
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
      default:
        console.error("usage: bun scripts/release.ts plan | set <version> | notes [version] | release-pr [version] | publish <stable|nightly> <version> <files…>");
        process.exit(2);
    }
  } catch (err) {
    console.error(`release: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
