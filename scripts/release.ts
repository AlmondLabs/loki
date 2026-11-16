// Release management (docs/releasing.md). A stable ships when the release PR merges, as many a day as there are
// merges; every other merge to main ships a nightly. Each is built for the Mac, Windows and Linux in one run, and
// carries the signed update files and the `latest.json` loki's updater reads (plan 2026-11-15-2319, U6).
//
// A stable is `YYYY.MMDD.N`: the UTC year, then month and day (October 11 is 1011, January 1 is 101), then that day's
// release count from 0 — 2026.1011.0, 2026.1011.1, 2026.1012.0. A nightly is the next stable's number and the release
// workflow's run number: `2026.1011.1-nightly.4821`, so nightlies rise run by run and each sorts below the stable it
// leads up to (semver precedence); the commit it was built from goes in its title and notes. The number is decided
// once per run, in the workflow's queued version job, from the date, the stable tags and the drafts, never written into
// a PR beforehand, so nothing goes stale and nothing runs on a schedule. A stable's draft is made there at once, so a
// stable queued behind it takes the next number. The tags are the truth; the version files on main are stamped only on
// the runner (main takes changes through PRs alone).
// `.github/workflows/release.yml` runs this on every push to main, and by hand:
//
//   npm run release -- plan                    what this run does: stable | nightly | none
//   npm run release -- version stable [sha]    the number this stable gets, from the tags and drafts as they are now
//   npm run release -- version nightly <run>   the same for a nightly, from the workflow's run number
//   npm run release -- draft <version>         the stable's draft release at that number, for HEAD, made once
//   npm run release -- set <version>           stamp the three version files (+ Cargo.lock), uncommitted
//   npm run release -- notes [version]         release notes from the commits since the last stable
//   npm run release -- release-pr              create, refresh or close the one release PR (branch release/next)
//   npm run release -- latest-json <version> <dir>       print the latest.json for the builds' files in dir
//   npm run release -- publish <kind> <version> <dir>    the GitHub release from the builds' files: a new vX, or the
//                                                         rolling nightly
//   npm run release -- prune-nightly <version>  take every other version's files off the rolling nightly
//
// Each release carries every system's versioned files, `latest.json`, and unversioned copies of what the install
// scripts fetch (KTD9), replaced on every release and never pruned.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions } from "../core/version.ts";
import { dmgName } from "./cask.ts";

/** What a release run does: ship a stable, the rolling nightly, or nothing. */
export type Kind = "stable" | "nightly" | "none";
/** What `plan` decided for this push, and why (`reason`, a line for the run's log). */
export interface Plan {
  kind: Kind;
  /**
   * The number this run would get as the tags stand now, for the log only: the version job decides it in the queue,
   * after any stable queued before it has drafted its own.
   */
  version: string;
  reason: string;
}

/** The one release PR's branch; merging that PR is what ships a stable. */
export const RELEASE_BRANCH = "release/next";
/** The release PR's one file: the main it was built from. Merging it is what makes a run a stable. */
export const RELEASE_FILE = ".github/release.txt";
/** The rolling nightly's tag and release: each nightly adds its files, moves the tag, then removes the last one's. */
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

/** The UTC day as a stable's middle number: month then two-digit day, October 11 → "1011", January 1 → "101". */
export const dayNumber = (d: Date): string => `${d.getUTCMonth() + 1}${String(d.getUTCDate()).padStart(2, "0")}`;
/**
 * `YYYY.MMDD.N`: three integers (semver, macOS bundle versions, Cargo, and Windows installers' 65535 cap per part),
 * and newer than every `YYYY.M.D` stable before it, since a month and day (101 to 1231) outnumber a month (1 to 12).
 */
export const stableVersion = (d: Date, n: number): string => `${d.getUTCFullYear()}.${dayNumber(d)}.${n}`;
/** Whether `v` is a stable's number, `YYYY.MMDD.N` with a real month and day (not the older `YYYY.M.D`). */
export const isStableVersion = (v: string): boolean => /^\d{4}\.(?:[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\.\d+$/.test(v);
/**
 * Whether `v` is a nightly's number: the next stable's, then `-nightly.` and the workflow's run number (no leading
 * zero, which semver forbids). The older `-nightly.<sha>` shape is not one: no new nightly is numbered so.
 */
export const isNightlyVersion = (v: string): boolean => /^\d+\.\d+\.\d+-nightly\.[1-9]\d*$/.test(v);

/** A sort comparator by semver precedence, oldest first; throws on anything that is not a version. */
export const byVersion = (a: string, b: string): number => {
  const order = compareVersions(a, b);
  if (order === null) throw new Error(`cannot compare ${a} with ${b}: not both versions`);
  return order;
};

/** The newest stable among the tags (or the published releases, as `v…`), as a version without the `v`; null when nothing has shipped. */
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

/**
 * A nightly: the stable it leads up to, and the release workflow's run number. It sorts after the last stable and
 * before the next, and after every earlier nightly, since run numbers only rise.
 */
export const nightlyVersion = (stable: string, run: number): string => `${stable}-nightly.${run}`;

const STABLE_TAG = /^v\d+\.\d+\.\d+$/;

/** A release as the numbering sees it: its tag, and the commit it was made for (a draft's tag exists only here). */
export interface ReleaseRef {
  tag: string;
  target: string;
}

/**
 * The stable already made for `sha`, draft or public, as a version; null when none was. A run of the release job
 * again for the same merge takes this number, so a re-run after a failed step finishes that stable rather than
 * shipping the same commit as the next one.
 */
export function stableFor(sha: string, releases: readonly ReleaseRef[]): string | null {
  const mine = releases.filter((r) => r.target === sha && STABLE_TAG.test(r.tag)).map((r) => r.tag.slice(1));
  return mine.sort(byVersion).at(-1) ?? null;
}
const stablesIn = (tags: string[]): string[] => tags.filter((t) => STABLE_TAG.test(t)).map((t) => t.slice(1));

/**
 * The number a stable gets, decided once in the release workflow's queued version job: the one already made for its
 * commit (a re-run finishes that stable), else today's next, counting the tags and every release, drafts included. The
 * version job drafts the stable at once, so a stable queued behind it sees the draft and takes the next number: two
 * release merges in a day make .0 and .1.
 */
export function decideStable({ today, sha, tags, releases }: { today: Date; sha: string; tags: string[]; releases: readonly ReleaseRef[] }): string {
  return stableFor(sha, releases) ?? nextStable(today, [...tags, ...releases.map((r) => r.tag)]);
}

/**
 * What a run does, on a push to main. The release PR landing is recognised by the push changing RELEASE_FILE
 * (`releaseMerged`): a stable, numbered in the queue. Everything else with commits since the last stable is a nightly;
 * nothing new is nothing to do. `shipped` is the stables published so far (by default every stable tag).
 */
export function plan({
  today,
  run,
  tags,
  shipped = stablesIn(tags),
  commitsSinceStable,
  releaseMerged = false,
}: {
  today: Date;
  /** The release workflow's run number, which numbers a nightly. */
  run: number;
  tags: string[];
  shipped?: string[];
  commitsSinceStable: number;
  releaseMerged?: boolean;
}): Plan {
  const latest = latestStable(shipped.map((v) => `v${v}`));
  if (releaseMerged) return { kind: "stable", version: nextStable(today, tags), reason: "the release PR landed; the version job numbers the stable" };
  if (commitsSinceStable === 0) return { kind: "none", version: latest ?? "", reason: "nothing since the last stable" };
  return {
    kind: "nightly",
    version: nightlyVersion(nextStable(today, tags), run),
    reason: `${commitsSinceStable} commit${commitsSinceStable === 1 ? "" : "s"} since ${latest === null ? "the beginning" : `v${latest}`}`,
  };
}

/** A commit as the release notes read it. */
export interface Commit {
  sha: string;
  subject: string;
  body: string;
}

const TRAILER = /^(Co-Authored-By|Signed-off-by|Reviewed-by|Co-authored-by):/i;

/**
 * The commits that are changes, not the release PR's own (or the retired Windows and Linux PR's): `chore(release): …`,
 * or `release: …` from before the titles followed Conventional Commits (docs/style.md §9).
 */
export const shipping = (commits: Commit[]): Commit[] => commits.filter((c) => !/^(chore\(release\)|release): /.test(c.subject));

/** GitHub refuses a release body over 125,000 characters; the notes stay under it with room to spare. */
export const RELEASE_NOTES_MAX = 120_000;
/** GitHub refuses a pull request body over 65,536 characters; the release PR's notes leave room for its own words. */
export const PR_NOTES_MAX = 60_000;

/**
 * Release notes: one entry per commit since the last stable, newest first; the release commits themselves and
 * trailers are left out. Notes longer than `max` (GitHub's limit, so a release or PR is never refused for its body)
 * drop the commit bodies first, then the oldest entries, ending with how many were left out and `fullList`, a link to
 * all of them, when given.
 */
export function releaseNotes(version: string, commits: Commit[], { max = RELEASE_NOTES_MAX, fullList }: { max?: number; fullList?: string } = {}): string {
  const changes = shipping(commits);
  const subject = (c: Commit) => `- **${c.subject.trim()}** (${c.sha.slice(0, 7)})`;
  const withBody = (c: Commit) => {
    const body = c.body
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => !TRAILER.test(l))
      .join("\n")
      .trim();
    return `${subject(c)}${
      body
        ? `\n${body
            .split("\n")
            .map((l) => (l ? `  ${l}` : ""))
            .join("\n")}`
        : ""
    }`;
  };
  const head = `## ${version}\n\n`;
  const notes = (entries: string[]) => `${head}${entries.length ? entries.join("\n") : "- no changes recorded"}\n`;
  const full = notes(changes.map(withBody));
  if (full.length <= max) return full;
  const subjects = changes.map(subject);
  const short = notes(subjects);
  if (short.length <= max) return short;
  const more = (n: number) => `- and ${n} earlier changes${fullList ? `: ${fullList}` : ""}\n`;
  let kept = 0;
  let used = head.length + more(subjects.length).length;
  while (kept < subjects.length && used + subjects[kept].length + 1 <= max) used += subjects[kept++].length + 1;
  return `${head}${subjects.slice(0, kept).join("\n")}\n${more(subjects.length - kept)}`;
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
/** Every release, drafts included (the build's token sees them), with the commit each was made for. */
function releaseRefs(): ReleaseRef[] {
  return gh("api", "--paginate", `repos/${repoName()}/releases?per_page=100`, "--jq", ".[] | [.tag_name, .target_commitish] | @tsv")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [tag = "", target = ""] = line.split("\t");
      return { tag, target };
    });
}
/**
 * The stables published so far: the versions of the public releases carrying a `.dmg`, from GitHub. A tag alone may be
 * a release still being made, or one from before every stable carried every system.
 */
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
/** The last stable published, which the notes and the nightly count from. */
const lastStable = (): string | null => latestStable(shipped().map((v) => `v${v}`));
function commitsSince(tag: string | null, head = "HEAD"): Commit[] {
  const range = tag ? `v${tag}..${head}` : head;
  const raw = git("log", range, "--no-merges", "--format=%H%x00%s%x00%b%x1e");
  return raw
    .split("\x1e")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [sha, subject, body = ""] = r.split("\x00");
      return { sha, subject, body };
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

function cmdPlan(): void {
  // Only a push is a merge; a manual run refreshes the release PR and builds a nightly that is never published.
  const pushed = (process.env.GITHUB_EVENT_NAME ?? "push") === "push";
  const p = plan({
    today: new Date(),
    // The plan job's run number is the build's: one workflow run. Outside Actions the nightly it names is only a guess.
    run: Number(process.env.GITHUB_RUN_NUMBER ?? 0),
    tags: tags(),
    shipped: shipped(),
    commitsSinceStable: shipping(commitsSince(lastStable())).length,
    releaseMerged: pushed && changedAtHead(RELEASE_FILE),
  });
  console.error(`release: ${p.kind}${p.version ? ` (as the tags stand, ${p.version})` : ""} — ${p.reason}`);
  output({ kind: p.kind });
}

/**
 * The number this run gets, from the tags and releases as they are when the version job starts (`decideStable`). A
 * stable takes its commit (`ref`, HEAD when left out), a nightly the workflow's run number.
 */
function cmdVersion(kind: string, ref: string | undefined): string {
  git("fetch", "--tags", "--force", "--quiet", "origin");
  if (kind === "stable") return decideStable({ today: new Date(), sha: ref ?? git("rev-parse", "HEAD"), tags: tags(), releases: releaseRefs() });
  if (kind === "nightly") {
    if (ref === undefined) throw new Error("version nightly: give the release workflow's run number");
    return nightlyVersion(nextStable(new Date(), tags()), Number(ref));
  }
  throw new Error(`version: kind is stable or nightly, not ${kind}`);
}

function cmdNotes(version: string): string {
  const last = lastStable();
  return releaseNotes(version, commitsSince(last), { fullList: fullList(last, git("rev-parse", "HEAD")) });
}

/** GitHub's comparison of everything since the last stable, which notes too long to list in full link to. */
const fullList = (last: string | null, to: string): string | undefined =>
  last === null ? undefined : `https://github.com/${repoName()}/compare/v${last}...${to}`;

/** A pull request body, written to a file for `gh --body-file`: a long one does not fit in a command line (E2BIG). */
function bodyFile(name: string, body: string): string {
  const path = join(root, name);
  writeFileSync(path, body);
  return path;
}

/** The release PR's title, body and the file its one commit writes. */
export function releasePr({ notes, mainSha, ifMergedNow }: { notes: string; mainSha: string; ifMergedNow: string }): {
  title: string;
  body: string;
  marker: string;
} {
  return {
    title: "chore(release): the next stable",
    marker: `${mainSha}\n`,
    body: [
      `Merging this ships **the next stable of loki**: the tag, the published release with the universal \`.dmg\`, the Windows installer, the Linux AppImage and \`.deb\` and the update files every loki installs from, and the Homebrew cask, from one workflow run. Its number is decided when it is built, \`YYYY.MMDD.N\` — the UTC day, then that day's count from 0 — so merged now it would be **${ifMergedNow}**.`,
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
  const notes = releaseNotes(ifMergedNow, pending, { max: PR_NOTES_MAX, fullList: fullList(lastStable(), mainSha) });
  const { title, body, marker } = releasePr({ notes, mainSha, ifMergedNow });
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
  const file = bodyFile(".release-pr.md", body);
  if (open) gh("pr", "edit", open, "--title", title, "--body-file", file);
  else gh("pr", "create", "--base", "main", "--head", RELEASE_BRANCH, "--title", title, "--body-file", file);
  console.error(`release: PR ${open ? `#${open} refreshed` : "opened"}; merged now it would be ${ifMergedNow}`);
}

/** A release as publishing needs it: whether it is still a draft, the commit it is for, and its files' names. */
export interface ReleaseState {
  draft: boolean;
  target: string;
  assets: string[];
}

/** The release at `tag`, draft or not; null when there is none. */
export function releaseState(tag: string, gh: (...args: string[]) => string): ReleaseState | null {
  let raw: string;
  try {
    raw = gh("release", "view", tag, "--json", "isDraft,targetCommitish,assets");
  } catch {
    return null;
  }
  const r = JSON.parse(raw) as { isDraft?: unknown; targetCommitish?: unknown; assets?: unknown };
  const names = (Array.isArray(r.assets) ? r.assets : []).map((a: unknown) => (typeof a === "object" && a !== null ? (a as { name?: unknown }).name : null));
  const assets = names.filter((n): n is string => typeof n === "string");
  return { draft: r.isDraft === true, target: typeof r.targetCommitish === "string" ? r.targetCommitish : "", assets };
}

/** The stable's release at `tag`, made a draft for `sha` (no tag yet) when there is none. Throws when another commit holds it. */
function stableRelease(version: string, sha: string, notesFile: string, gh: (...args: string[]) => string): ReleaseState | null {
  if (!isStableVersion(version)) throw new Error(`a stable looks like 2026.1011.0, not ${version}`);
  const tag = `v${version}`;
  const state = releaseState(tag, gh);
  if (state && state.target !== sha)
    throw new Error(`${tag} already exists for another commit (${state.target.slice(0, 7)}): this build's number was taken; re-run the run to number it again`);
  if (!state) gh("release", "create", tag, "--draft", "--target", sha, "--title", `loki ${version}`, "--notes-file", notesFile);
  return state;
}

/**
 * The stable's draft, made by the version job the moment its number is decided (KTD10), so a stable queued behind it
 * sees the number as taken. Run again for the same merge it changes nothing; a number another merge holds fails.
 */
export function draftStable({ version, sha, notesFile, gh }: { version: string; sha: string; notesFile: string; gh: (...args: string[]) => string }): void {
  stableRelease(version, sha, notesFile, gh);
}

// --- the update files ---------------------------------------------------------------------------------------

/**
 * The platform keys latest.json lists, as tauri-plugin-updater looks them up (`<os>-<arch>`, after
 * `<os>-<arch>-<installer>`). The universal Mac build answers both Mac architectures; `darwin-universal` is
 * tauri-action's own name for it, kept for anyone reading the file.
 */
export const UPDATE_PLATFORMS = ["darwin-universal", "darwin-aarch64", "darwin-x86_64", "windows-x86_64", "linux-x86_64"] as const;

/**
 * The unversioned copies every release carries for the install scripts (KTD9): the Mac's update archive, the Windows
 * installer and the AppImage. The scripts fetch them from `releases/latest/download/` or `releases/download/nightly/`
 * without asking GitHub's API which file is newest. Replaced on every release, never pruned.
 */
export const INSTALL_FILES = ["loki-macos-universal.app.tar.gz", "loki-windows-x64-setup.exe", "loki-linux-x86_64.AppImage"] as const;

/** A system's update file: the name its build gives it, the versioned name it ships as, the install scripts' copy, and its platform keys. */
interface UpdateFile {
  built: string;
  shipped: string;
  install: string;
  platforms: readonly string[];
}

/** The three update files a release's builds make (createUpdaterArtifacts): the Mac's archive, and the Windows and Linux installers themselves. */
const updateFiles = (version: string): UpdateFile[] => [
  // The bundler names the Mac's archive after the app alone, so it ships under a versioned name like the other two.
  { built: "loki.app.tar.gz", shipped: `loki_${version}_universal.app.tar.gz`, install: INSTALL_FILES[0], platforms: UPDATE_PLATFORMS.slice(0, 3) },
  { built: `loki_${version}_x64-setup.exe`, shipped: `loki_${version}_x64-setup.exe`, install: INSTALL_FILES[1], platforms: ["windows-x86_64"] },
  { built: `loki_${version}_amd64.AppImage`, shipped: `loki_${version}_amd64.AppImage`, install: INSTALL_FILES[2], platforms: ["linux-x86_64"] },
];

/** latest.json as tauri-plugin-updater 2 reads it (its `RemoteRelease`): the version, notes, an RFC 3339 date, and per platform the download and its signature. */
export interface LatestJson {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { url: string; signature: string }>;
}

/** latest.json for `updates`, each file listed under its platform keys at `baseUrl`, the release's own download folder. */
export function latestJson({
  version,
  notes,
  now,
  baseUrl,
  updates,
}: {
  version: string;
  notes: string;
  now: Date;
  baseUrl: string;
  updates: ReadonlyArray<{ name: string; signature: string; platforms: readonly string[] }>;
}): LatestJson {
  const platforms: LatestJson["platforms"] = {};
  for (const u of updates) for (const p of u.platforms) platforms[p] = { url: `${baseUrl}/${u.name}`, signature: u.signature };
  return { version, notes, pub_date: now.toISOString(), platforms };
}

/** Every file under `dir`, by name: actions/download-artifact keeps each artifact's own folders. */
function filesByName(dir: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const rel of readdirSync(dir, { recursive: true, encoding: "utf8" })) if (!found.has(basename(rel))) found.set(basename(rel), join(dir, rel));
  return found;
}

/** What the three builds made, found under `from`: every bundle and every update signature, or an error naming what is missing. */
function builtFiles(from: string, version: string): { path: (name: string) => string; updates: Array<UpdateFile & { signature: string }> } {
  const found = filesByName(from);
  const read = (name: string) => {
    const path = found.get(name);
    return path === undefined ? "" : readFileSync(path, "utf8").trim();
  };
  const updates = updateFiles(version).map((u) => ({ ...u, signature: read(`${u.built}.sig`) }));
  // A release without one system's signature would leave that system's loki unable to update: nothing ships.
  const unsigned = updates.filter((u) => !u.signature).flatMap((u) => u.platforms);
  if (unsigned.length) throw new Error(`no update signature for ${unsigned.join(", ")}: was TAURI_SIGNING_PRIVATE_KEY set for every build?`);
  const absent = [dmgName(version), ...updates.map((u) => u.built), `loki_${version}_amd64.deb`].filter((n) => !found.has(n));
  if (absent.length) throw new Error(`the builds did not make ${absent.join(", ")}`);
  return { path: (name) => found.get(name) ?? join(from, name), updates };
}

/** The release's download folder for `tag`, where latest.json's URLs point. */
const downloadBase = (repo: string, tag: string) => `https://github.com/${repo}/releases/download/${tag}`;

/** What a release uploads, staged under their release names: the versioned files in upload order, then latest.json and the install copies. */
export interface Staged {
  versioned: string[];
  rolling: string[];
  /** The staged `.dmg`, which the cask is made from. */
  dmg: string;
}

/**
 * Stage a release from the builds' files under `from` into `to`: every versioned file (the `.dmg`, each update file
 * and its `.sig`, the `.deb`), latest.json pointing at the versioned update files on the release at `tag`, and the
 * install scripts' unversioned copies. Throws, staging nothing, when a signature or a bundle is missing.
 */
export function stageRelease({
  version,
  tag,
  repo,
  notes,
  now,
  from,
  to,
}: {
  version: string;
  tag: string;
  repo: string;
  notes: string;
  now: Date;
  from: string;
  to: string;
}): Staged {
  const { path, updates } = builtFiles(from, version);
  mkdirSync(to, { recursive: true });
  const stage = (source: string, name: string) => {
    copyFileSync(path(source), join(to, name));
    return join(to, name);
  };
  const dmg = stage(dmgName(version), dmgName(version));
  const versioned = [
    dmg,
    ...updates.flatMap((u) => [stage(u.built, u.shipped), stage(`${u.built}.sig`, `${u.shipped}.sig`)]),
    stage(`loki_${version}_amd64.deb`, `loki_${version}_amd64.deb`),
  ];
  const latest = latestJson({ version, notes, now, baseUrl: downloadBase(repo, tag), updates: updates.map((u) => ({ ...u, name: u.shipped })) });
  writeFileSync(join(to, "latest.json"), `${JSON.stringify(latest, null, 2)}\n`);
  const rolling = [join(to, "latest.json"), ...updates.map((u) => stage(u.built, u.install))];
  return { versioned, rolling, dmg };
}

// --- publishing ---------------------------------------------------------------------------------------------

/** The public stables' tags, newest first as GitHub lists them. */
const publicStables = (gh: (...args: string[]) => string): string[] =>
  gh("release", "list", "--exclude-drafts", "--exclude-pre-releases", "--limit", "100", "--json", "tagName", "--jq", ".[].tagName").split("\n").filter(Boolean);

/**
 * The nightly version a release title announces, `loki <version> (<stable>-nightly.<sha>)`: its first run-numbered
 * nightly version, or null for a title without one (the older `-nightly.<sha>` shape).
 */
const nightlyAnnounced = (title: string): string | null => /\d+\.\d+\.\d+-nightly\.\d+(?![0-9A-Za-z])/.exec(title)?.[0] ?? null;

/**
 * Publish a release's files, each step safe to run again (plan 096): the versioned files first, then latest.json and
 * the install copies with `--clobber`, so nothing announces a version whose files are not up. A stable's draft (made by
 * the version job, or here when it is missing) gets its files, then is made public and latest; a run again for the same
 * merge picks up where the last one stopped, and one whose release is already public changes nothing on it. A release
 * at this number made for another commit is never joined: two builds' files never share a release. A nightly keeps its
 * release: the new files go up beside the last nightly's, the tag moves to this merge, and latest.json goes last, so a
 * run cancelled at any point leaves a nightly that downloads (`prune-nightly`, after the tap has moved, removes the old
 * files). A nightly older than the one the release announces (a re-run after a newer merge's went out) fails before it
 * uploads anything.
 *
 * Answers the `.dmg` the cask is made from: this build's, or, when the stable was already public, the one it shipped
 * with, downloaded to `downloadDir`, since a rebuild is not the same file and its checksum would not match.
 */
export function publish({
  kind,
  version,
  versioned,
  rolling,
  sha,
  notesFile,
  repo = "",
  downloadDir = ".",
  gh,
}: {
  kind: string;
  version: string;
  versioned: string[];
  rolling: string[];
  sha: string;
  notesFile: string;
  repo?: string;
  downloadDir?: string;
  gh: (...args: string[]) => string;
}): { dmg: string } {
  if (!versioned.length || !rolling.length) throw new Error("publish: no files");
  const dmg = versioned.find((f) => f.endsWith(".dmg")) ?? versioned[0];
  const upload = (tag: string, files: string[]) => gh("release", "upload", tag, ...files, "--clobber");
  if (kind === "stable") {
    if (!isStableVersion(version)) throw new Error(`a stable looks like 2026.1011.0, not ${version}`);
    const tag = `v${version}`;
    const state = stableRelease(version, sha, notesFile, gh);
    if (state && !state.draft) {
      const shipped = state.assets.find((a) => a.endsWith(".dmg"));
      if (!shipped) throw new Error(`${tag} is public but carries no .dmg`);
      gh("release", "download", tag, "--pattern", shipped, "--dir", downloadDir, "--clobber");
      return { dmg: join(downloadDir, shipped) };
    }
    upload(tag, versioned);
    upload(tag, rolling);
    // Stables build side by side, so an earlier one can finish after a later one is out: it is never made latest over
    // it, which would take `releases/latest` (latest.json, the install scripts' files) back a version.
    const newest = latestStable(publicStables(gh));
    gh("release", "edit", tag, "--draft=false", newest === null || byVersion(newest, version) <= 0 ? "--latest" : "--latest=false");
    return { dmg };
  }
  if (kind === "nightly") {
    if (!isNightlyVersion(version)) throw new Error(`a nightly version looks like 2026.1011.1-nightly.4821, not ${version}`);
    // The version no longer names the commit, so the title does, in the old `<stable>-nightly.<sha>` shape: nightlies
    // installed before run numbers read only that shape from the title, so they still see this one as newer. Drop the
    // old shape once those nightlies are gone.
    const title = `loki ${version} (${version.replace(/-nightly\..*$/, "")}-nightly.${sha.slice(0, 7)})`;
    const state = releaseState(NIGHTLY_TAG, gh);
    if (!state) {
      // A tag left without its release (the old delete-then-create, cancelled between the two) would pin the new
      // release to the old commit: it goes first.
      try {
        gh("api", "-X", "DELETE", `repos/${repo}/git/refs/tags/${NIGHTLY_TAG}`);
      } catch {
        // no such tag
      }
      gh("release", "create", NIGHTLY_TAG, "--target", sha, "--prerelease", "--title", title, "--notes-file", notesFile, ...versioned);
      upload(NIGHTLY_TAG, rolling);
      return { dmg };
    }
    // A re-run of an older run after a newer nightly went out would take the channel back a version and its prune
    // would delete the newer files, so it stops here; the failed step keeps the cask, tap and prune steps from running.
    const announced = nightlyAnnounced(gh("release", "view", NIGHTLY_TAG, "--json", "name", "--jq", ".name"));
    if (announced !== null && byVersion(announced, version) > 0) {
      throw new Error(`the nightly already announces ${announced}, newer than this run's ${version}: nothing was published`);
    }
    upload(NIGHTLY_TAG, versioned);
    gh("api", "-X", "PATCH", `repos/${repo}/git/refs/tags/${NIGHTLY_TAG}`, "-f", `sha=${sha}`, "-F", "force=true");
    gh("release", "edit", NIGHTLY_TAG, "--title", title, "--notes-file", notesFile, "--prerelease");
    upload(NIGHTLY_TAG, rolling);
    return { dmg };
  }
  throw new Error(`publish: kind is stable or nightly, not ${kind}`);
}

/** A release file that carries a version in its name, `loki_<version>_…`; latest.json and the install copies carry none. */
const VERSIONED_FILE = /^loki_(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)_/;

/** The nightly's files carrying a version other than `version`: the ones earlier nightlies left, removed once the tap has moved on. */
export const staleNightlyFiles = (assets: readonly string[], version: string): string[] =>
  assets.filter((a) => {
    const carried = VERSIONED_FILE.exec(a)?.[1];
    return carried !== undefined && carried !== version;
  });

/** Remove the files earlier nightlies left on the rolling release, now that latest.json and the tap point at `version`. */
export function pruneNightly(version: string, gh: (...args: string[]) => string): string[] {
  const state = releaseState(NIGHTLY_TAG, gh);
  if (!state) return [];
  const stale = staleNightlyFiles(state.assets, version);
  for (const name of stale) gh("release", "delete-asset", NIGHTLY_TAG, name, "--yes");
  return stale;
}

/** The release's tag: `v<version>` for a stable, the rolling `nightly` for a nightly. */
const releaseTag = (version: string): string => (isNightlyVersion(version) ? NIGHTLY_TAG : `v${version}`);

/** The release's notes, written to a file for `gh --notes-file`; a nightly's say which merge it is, since its version carries its run. */
function notesFor(version: string, sha: string): { text: string; file: string } {
  const notes = cmdNotes(version).replace(/^## .*\n\n/, "");
  const text = isNightlyVersion(version) ? `Built from ${sha}.\n\n${notes}` : notes;
  return { text, file: bodyFile(".release-notes.md", text) };
}

function cmdDraft(version: string): void {
  const sha = git("rev-parse", "HEAD");
  draftStable({ version, sha, notesFile: notesFor(version, sha).file, gh });
  console.error(`release: v${version} is drafted for ${sha.slice(0, 7)}`);
}

function cmdLatestJson(version: string, dir: string): string {
  const { updates } = builtFiles(dir, version);
  const notes = notesFor(version, git("rev-parse", "HEAD")).text;
  const json = latestJson({
    version,
    notes,
    now: new Date(),
    baseUrl: downloadBase(repoName(), releaseTag(version)),
    updates: updates.map((u) => ({ ...u, name: u.shipped })),
  });
  return `${JSON.stringify(json, null, 2)}\n`;
}

function cmdPublish(kind: string, version: string, dir: string): void {
  if (!dir) throw new Error("publish: give the folder the builds' files were downloaded to");
  const sha = git("rev-parse", "HEAD");
  const notes = notesFor(version, sha);
  const to = join(root, ".release-assets");
  rmSync(to, { recursive: true, force: true });
  const staged = stageRelease({ version, tag: releaseTag(version), repo: repoName(), notes: notes.text, now: new Date(), from: dir, to });
  const { dmg } = publish({
    kind,
    version,
    versioned: staged.versioned,
    rolling: staged.rolling,
    sha,
    notesFile: notes.file,
    repo: repoName(),
    downloadDir: join(root, ".release-shipped"),
    gh,
  });
  console.error(`release: published ${kind} ${version}`);
  // The step after reads which .dmg to make the cask from.
  output({ dmg });
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
        console.log(cmdVersion(args[0] ?? "", args[1]));
        break;
      case "draft":
        cmdDraft(args[0] ?? "");
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
      case "latest-json":
        process.stdout.write(cmdLatestJson(args[0] ?? "", args[1] ?? "."));
        break;
      case "publish":
        cmdPublish(args[0] ?? "", args[1] ?? "", args[2] ?? "");
        break;
      case "prune-nightly": {
        const gone = pruneNightly(args[0] ?? "", gh);
        console.error(`release: removed ${gone.length} earlier nightly file${gone.length === 1 ? "" : "s"}`);
        break;
      }
      default:
        console.error(
          "usage: npm run release -- plan | version stable [sha] | version nightly <run> | draft <version> | set <version> | notes [version] | release-pr | latest-json <version> <dir> | publish <stable|nightly> <version> <dir> | prune-nightly <version>",
        );
        process.exit(2);
    }
  } catch (err) {
    console.error(`release: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
