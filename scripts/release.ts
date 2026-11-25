import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions } from "../core/version.ts";
import type { PlatformKey } from "../desktop/update/remote.ts";
import { dmgName } from "./cask.ts";

export type Kind = "stable" | "nightly" | "none";
export interface Plan {
  kind: Kind;
  version: string;
  reason: string;
}

export const NIGHTLY_TAG = "nightly";
const root = fileURLToPath(new URL("..", import.meta.url));

function repoName(): string {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const { repository } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { repository?: string };
  return (repository ?? "")
    .replace(/^github:/, "")
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/\.git$/, "");
}

export const dayNumber = (d: Date): string => `${d.getUTCMonth() + 1}${String(d.getUTCDate()).padStart(2, "0")}`;
// Outside (Windows): installers cap each part of a version at 65535, and semver, Cargo and macOS bundle versions take
// three integers.
export const stableVersion = (d: Date, n: number): string => `${d.getUTCFullYear()}.${dayNumber(d)}.${n}`;
export const isStableVersion = (v: string): boolean => /^\d{4}\.(?:[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\.\d+$/.test(v);
export const isNightlyVersion = (v: string): boolean => /^\d+\.\d+\.\d+-nightly\.[1-9]\d*$/.test(v);

export const byVersion = (a: string, b: string): number => {
  const order = compareVersions(a, b);
  if (order === null) throw new Error(`cannot compare ${a} with ${b}: not both versions`);
  return order;
};

export function latestStable(tags: string[]): string | null {
  const stable = tags.filter((t) => /^v\d+\.\d+\.\d+$/.test(t)).sort(byVersion);
  return stable.length ? stable[stable.length - 1].slice(1) : null;
}

export function nextStable(today: Date, tags: string[]): string {
  const prefix = `v${today.getUTCFullYear()}.${dayNumber(today)}.`;
  const taken = tags.filter((t) => t.startsWith(prefix) && /^\d+$/.test(t.slice(prefix.length))).map((t) => Number(t.slice(prefix.length)));
  return stableVersion(today, taken.length ? Math.max(...taken) + 1 : 0);
}

export const nightlyVersion = (stable: string, run: number): string => `${stable}-nightly.${run}`;

const STABLE_TAG = /^v\d+\.\d+\.\d+$/;

export interface ReleaseRef {
  tag: string;
  target: string;
}

export function stableFor(sha: string, releases: readonly ReleaseRef[]): string | null {
  const mine = releases.filter((r) => r.target === sha && STABLE_TAG.test(r.tag)).map((r) => r.tag.slice(1));
  return mine.sort(byVersion).at(-1) ?? null;
}
const stablesIn = (tags: string[]): string[] => tags.filter((t) => STABLE_TAG.test(t)).map((t) => t.slice(1));

export function decideStable({ today, sha, tags, releases }: { today: Date; sha: string; tags: string[]; releases: readonly ReleaseRef[] }): string {
  return stableFor(sha, releases) ?? nextStable(today, [...tags, ...releases.map((r) => r.tag)]);
}

export type Requested = "stable" | "nightly";

export function requestedKind(value: string | undefined): Requested {
  if (value === undefined || value === "" || value === "nightly") return "nightly";
  if (value === "stable") return "stable";
  throw new Error(`the kind asked for is stable or nightly, not ${value}`);
}

export function plan({
  today,
  run,
  tags,
  shipped = stablesIn(tags),
  requested,
  commitsSinceStable,
}: {
  today: Date;
  run: number;
  tags: string[];
  shipped?: string[];
  requested: Requested;
  commitsSinceStable: number;
}): Plan {
  const latest = latestStable(shipped.map((v) => `v${v}`));
  if (commitsSinceStable === 0) return { kind: "none", version: latest ?? "", reason: "nothing since the last stable" };
  const since = `${commitsSinceStable} commit${commitsSinceStable === 1 ? "" : "s"} since ${latest === null ? "the beginning" : `v${latest}`}`;
  const next = nextStable(today, tags);
  if (requested === "stable") return { kind: "stable", version: next, reason: `${since}; the version job numbers the stable` };
  return { kind: "nightly", version: nightlyVersion(next, run), reason: since };
}

export interface Commit {
  sha: string;
  subject: string;
  body: string;
}

const TRAILER = /^(Co-Authored-By|Signed-off-by|Reviewed-by|Co-authored-by):/i;

const GITHUB_RELEASE_BODY_MAX = 125_000;
export const RELEASE_NOTES_MAX = GITHUB_RELEASE_BODY_MAX - 5_000;

export function releaseNotes(version: string, commits: Commit[], { max = RELEASE_NOTES_MAX, fullList }: { max?: number; fullList?: string } = {}): string {
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
  const full = notes(commits.map(withBody));
  if (full.length <= max) return full;
  const subjects = commits.map(subject);
  const short = notes(subjects);
  if (short.length <= max) return short;
  const more = (n: number) => `- and ${n} earlier changes${fullList ? `: ${fullList}` : ""}\n`;
  let kept = 0;
  let used = head.length + more(subjects.length).length;
  while (kept < subjects.length && used + subjects[kept].length + 1 <= max) used += subjects[kept++].length + 1;
  return `${head}${subjects.slice(0, kept).join("\n")}\n${more(subjects.length - kept)}`;
}

export function setVersion(version: string, dir = root): string[] {
  if (!isNightlyVersion(version) && !/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a version: ${version}`);
  if (!existsSync(join(dir, "package.json"))) throw new Error(`no package.json in ${dir} to stamp`);
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

const run = (cmd: string, args: string[], input?: string): string =>
  execFileSync(cmd, args, { cwd: root, encoding: "utf8", input, stdio: ["pipe", "pipe", "inherit"] }).trim();
const git = (...args: string[]) => run("git", args);
const gh = (...args: string[]) => run("gh", args);

function tags(): string[] {
  return git("tag", "--list").split("\n").filter(Boolean);
}
function releaseRefs(): ReleaseRef[] {
  return gh("api", "--paginate", `repos/${repoName()}/releases?per_page=100`, "--jq", ".[] | [.tag_name, .target_commitish] | @tsv")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [tag = "", target = ""] = line.split("\t");
      return { tag, target };
    });
}
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

function cmdPlan(): void {
  const p = plan({
    today: new Date(),
    run: Number(process.env.GITHUB_RUN_NUMBER ?? 0),
    tags: tags(),
    shipped: shipped(),
    requested: requestedKind(process.env.REQUESTED_KIND),
    commitsSinceStable: commitsSince(lastStable()).length,
  });
  const line = `release: ${p.kind}${p.version ? ` (as the tags stand, ${p.version})` : ""} — ${p.reason}`;
  console.error(line);
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`, { flag: "a" });
  output({ kind: p.kind });
}

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

const fullList = (last: string | null, to: string): string | undefined =>
  last === null ? undefined : `https://github.com/${repoName()}/compare/v${last}...${to}`;

// A long body does not fit in a command line: E2BIG in https://man7.org/linux/man-pages/man2/execve.2.html
function bodyFile(name: string, body: string): string {
  const path = join(root, name);
  writeFileSync(path, body);
  return path;
}

export interface ReleaseState {
  draft: boolean;
  target: string;
  assets: string[];
}

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

function stableRelease(version: string, sha: string, notesFile: string, gh: (...args: string[]) => string): ReleaseState | null {
  if (!isStableVersion(version)) throw new Error(`a stable looks like 2026.1011.0, not ${version}`);
  const tag = `v${version}`;
  const state = releaseState(tag, gh);
  if (state && state.target !== sha)
    throw new Error(`${tag} already exists for another commit (${state.target.slice(0, 7)}): this build's number was taken; re-run the run to number it again`);
  if (!state) gh("release", "create", tag, "--draft", "--target", sha, "--title", `loki ${version}`, "--notes-file", notesFile);
  return state;
}

export function draftStable({ version, sha, notesFile, gh }: { version: string; sha: string; notesFile: string; gh: (...args: string[]) => string }): void {
  stableRelease(version, sha, notesFile, gh);
}

export const UPDATE_PLATFORMS: readonly PlatformKey[] = ["darwin-aarch64", "windows-x86_64", "linux-x86_64"];

export const INSTALL_FILES = ["loki-macos-arm64.app.tar.gz", "loki-windows-x64-setup.exe", "loki-linux-x86_64.AppImage"] as const;

interface UpdateFile {
  built: string;
  shipped: string;
  install: string;
  platforms: readonly PlatformKey[];
}

export const MAC_UPDATE_ARCHIVE = "loki.app.tar.gz";

const updateFiles = (version: string): UpdateFile[] => [
  { built: MAC_UPDATE_ARCHIVE, shipped: `loki_${version}_aarch64.app.tar.gz`, install: INSTALL_FILES[0], platforms: ["darwin-aarch64"] },
  { built: `loki_${version}_x64-setup.exe`, shipped: `loki_${version}_x64-setup.exe`, install: INSTALL_FILES[1], platforms: ["windows-x86_64"] },
  { built: `loki_${version}_amd64.AppImage`, shipped: `loki_${version}_amd64.AppImage`, install: INSTALL_FILES[2], platforms: ["linux-x86_64"] },
];

export const DESKTOP_JSON = "desktop.json";
export const FROZEN_LATEST_JSON = "latest.json";

export interface DesktopJson {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Partial<Record<PlatformKey, { url: string; signature: string }>>;
}

export function desktopJson({
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
  updates: ReadonlyArray<{ name: string; signature: string; platforms: readonly PlatformKey[] }>;
}): DesktopJson {
  const platforms: DesktopJson["platforms"] = {};
  for (const u of updates) for (const p of u.platforms) platforms[p] = { url: `${baseUrl}/${u.name}`, signature: u.signature };
  return { version, notes, pub_date: now.toISOString(), platforms };
}

// Outside (GitHub Actions): actions/download-artifact keeps each artifact's own folders.
function filesByName(dir: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const rel of readdirSync(dir, { recursive: true, encoding: "utf8" })) if (!found.has(basename(rel))) found.set(basename(rel), join(dir, rel));
  return found;
}

function builtFiles(from: string, version: string): { path: (name: string) => string; updates: Array<UpdateFile & { signature: string }> } {
  const found = filesByName(from);
  const read = (name: string) => {
    const path = found.get(name);
    return path === undefined ? "" : readFileSync(path, "utf8").trim();
  };
  const updates = updateFiles(version).map((u) => ({ ...u, signature: read(`${u.built}.sig`) }));
  const unsigned = updates.filter((u) => !u.signature).flatMap((u) => u.platforms);
  if (unsigned.length) throw new Error(`no update signature for ${unsigned.join(", ")}: did every build's signing step (scripts/sign-update.ts) run?`);
  const absent = [dmgName(version), ...updates.map((u) => u.built), `loki_${version}_amd64.deb`].filter((n) => !found.has(n));
  if (absent.length) throw new Error(`the builds did not make ${absent.join(", ")}`);
  return { path: (name) => found.get(name) ?? join(from, name), updates };
}

const downloadBase = (repo: string, tag: string) => `https://github.com/${repo}/releases/download/${tag}`;

export interface Staged {
  versioned: string[];
  rolling: string[];
  manifest: string;
  dmg: string;
}

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
  const manifest = desktopJson({ version, notes, now, baseUrl: downloadBase(repo, tag), updates: updates.map((u) => ({ ...u, name: u.shipped })) });
  writeFileSync(join(to, DESKTOP_JSON), `${JSON.stringify(manifest, null, 2)}\n`);
  const rolling = updates.map((u) => stage(u.built, u.install));
  return { versioned, rolling, manifest: join(to, DESKTOP_JSON), dmg };
}

const publicStables = (gh: (...args: string[]) => string): string[] =>
  gh("release", "list", "--exclude-drafts", "--exclude-pre-releases", "--limit", "100", "--json", "tagName", "--jq", ".[].tagName").split("\n").filter(Boolean);

const stableOf = (nightly: string): string => nightly.replace(/-nightly\..*$/, "");
const nameOlderInstallsRead = (stable: string, sha: string): string => `${stable}-nightly.${sha.slice(0, 7)}`;
const nightlyTitle = (version: string, sha: string): string => `loki ${version} (${nameOlderInstallsRead(stableOf(version), sha)})`;
const nightlyAnnounced = (title: string): string | null => /\d+\.\d+\.\d+-nightly\.\d+(?![0-9A-Za-z])/.exec(title)?.[0] ?? null;

export function publish({
  kind,
  version,
  versioned,
  rolling,
  manifest,
  frozen,
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
  manifest: string;
  frozen: string;
  sha: string;
  notesFile: string;
  repo?: string;
  downloadDir?: string;
  gh: (...args: string[]) => string;
}): { dmg: string } {
  if (!versioned.length || !rolling.length) throw new Error("publish: no files");
  if (basename(manifest) !== DESKTOP_JSON || basename(frozen) !== FROZEN_LATEST_JSON)
    throw new Error(`publish: the manifests go up as ${DESKTOP_JSON} and ${FROZEN_LATEST_JSON}, not ${basename(manifest)} and ${basename(frozen)}`);
  const dmg = versioned.find((f) => f.endsWith(".dmg")) ?? versioned[0];
  const upload = (tag: string, files: string[]) => gh("release", "upload", tag, ...files, "--clobber");
  const finish = (tag: string) => {
    upload(tag, [...rolling, frozen]);
    upload(tag, [manifest]);
  };
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
    finish(tag);
    const newest = latestStable(publicStables(gh));
    gh("release", "edit", tag, "--draft=false", newest === null || byVersion(newest, version) <= 0 ? "--latest" : "--latest=false");
    return { dmg };
  }
  if (kind === "nightly") {
    if (!isNightlyVersion(version)) throw new Error(`a nightly version looks like 2026.1011.1-nightly.4821, not ${version}`);
    const title = nightlyTitle(version, sha);
    const state = releaseState(NIGHTLY_TAG, gh);
    if (!state) {
      // Outside (GitHub): a release created on a tag that already exists keeps the tag's commit, whatever `--target`
      // says, so a tag left without its release goes first.
      try {
        gh("api", "-X", "DELETE", `repos/${repo}/git/refs/tags/${NIGHTLY_TAG}`);
      } catch {}
      gh("release", "create", NIGHTLY_TAG, "--target", sha, "--prerelease", "--title", title, "--notes-file", notesFile, ...versioned);
      finish(NIGHTLY_TAG);
      return { dmg };
    }
    const announced = nightlyAnnounced(gh("release", "view", NIGHTLY_TAG, "--json", "name", "--jq", ".name"));
    if (announced !== null && byVersion(announced, version) > 0) {
      throw new Error(`the nightly already announces ${announced}, newer than this run's ${version}: nothing was published`);
    }
    upload(NIGHTLY_TAG, versioned);
    gh("api", "-X", "PATCH", `repos/${repo}/git/refs/tags/${NIGHTLY_TAG}`, "-f", `sha=${sha}`, "-F", "force=true");
    gh("release", "edit", NIGHTLY_TAG, "--title", title, "--notes-file", notesFile, "--prerelease");
    finish(NIGHTLY_TAG);
    return { dmg };
  }
  throw new Error(`publish: kind is stable or nightly, not ${kind}`);
}

function frozenVersion(path: string, version: string, from: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${from}'s latest.json is not JSON: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  const frozen = typeof parsed === "object" && parsed !== null && "version" in parsed ? parsed.version : undefined;
  if (typeof frozen !== "string" || compareVersions(frozen, version) === null) throw new Error(`${from}'s latest.json names no version`);
  if (byVersion(frozen, version) >= 0)
    throw new Error(
      `${from}'s latest.json announces ${frozen}, not older than ${version}: it is not the last Tauri release's, and a Tauri loki must never install this one`,
    );
  return frozen;
}

export function frozenLatestJson({
  kind,
  version,
  given,
  dir,
  gh,
}: {
  kind: string;
  version: string;
  given?: string;
  dir: string;
  gh: (...args: string[]) => string;
}): { path: string; version: string } {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const path = join(dir, FROZEN_LATEST_JSON);
  if (given) {
    copyFileSync(given, path);
    return { path, version: frozenVersion(path, version, given) };
  }
  const tag =
    kind === "nightly"
      ? NIGHTLY_TAG
      : publicStables(gh)
          .filter((t) => STABLE_TAG.test(t) && byVersion(t.slice(1), version) < 0)
          .sort((a, b) => byVersion(a.slice(1), b.slice(1)))
          .at(-1);
  if (tag === undefined) throw new Error(`no stable before ${version} carries a latest.json to freeze: give the last Tauri release's latest.json to publish`);
  try {
    gh("release", "download", tag, "--pattern", FROZEN_LATEST_JSON, "--dir", dir, "--clobber");
  } catch (err) {
    throw new Error(`could not download latest.json from ${tag} to carry it over: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  if (!existsSync(path)) throw new Error(`${tag} carries no latest.json to carry over: give the last Tauri release's latest.json to publish`);
  return { path, version: frozenVersion(path, version, tag) };
}

export function filesNamedBy(latestJsonText: string): string[] {
  const parsed: unknown = JSON.parse(latestJsonText);
  const platforms = typeof parsed === "object" && parsed !== null && "platforms" in parsed ? parsed.platforms : undefined;
  if (typeof platforms !== "object" || platforms === null) return [];
  const urls = Object.values(platforms).map((p: unknown) => (typeof p === "object" && p !== null && "url" in p ? p.url : undefined));
  return urls.filter((u): u is string => typeof u === "string").map((u) => decodeURIComponent(u.slice(u.lastIndexOf("/") + 1)));
}

const VERSIONED_FILE = /^loki_(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)_/;

export const staleNightlyFiles = (assets: readonly string[], version: string, keep: readonly string[] = []): string[] =>
  assets.filter((a) => {
    const carried = VERSIONED_FILE.exec(a)?.[1];
    return carried !== undefined && carried !== version && !keep.includes(a);
  });

export function pruneNightly(version: string, gh: (...args: string[]) => string, dir: string): string[] {
  const state = releaseState(NIGHTLY_TAG, gh);
  if (!state) return [];
  let keep: string[] = [];
  if (state.assets.includes(FROZEN_LATEST_JSON)) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    gh("release", "download", NIGHTLY_TAG, "--pattern", FROZEN_LATEST_JSON, "--dir", dir, "--clobber");
    keep = filesNamedBy(readFileSync(join(dir, FROZEN_LATEST_JSON), "utf8"));
  }
  const stale = staleNightlyFiles(state.assets, version, keep);
  for (const name of stale) gh("release", "delete-asset", NIGHTLY_TAG, name, "--yes");
  return stale;
}

const releaseTag = (version: string): string => (isNightlyVersion(version) ? NIGHTLY_TAG : `v${version}`);

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

function cmdDesktopJson(version: string, dir: string): string {
  const { updates } = builtFiles(dir, version);
  const notes = notesFor(version, git("rev-parse", "HEAD")).text;
  const json = desktopJson({
    version,
    notes,
    now: new Date(),
    baseUrl: downloadBase(repoName(), releaseTag(version)),
    updates: updates.map((u) => ({ ...u, name: u.shipped })),
  });
  return `${JSON.stringify(json, null, 2)}\n`;
}

function cmdPublish(kind: string, version: string, dir: string, given: string | undefined): void {
  if (!dir) throw new Error("publish: give the folder the builds' files were downloaded to");
  const sha = git("rev-parse", "HEAD");
  const notes = notesFor(version, sha);
  const to = join(root, ".release-assets");
  rmSync(to, { recursive: true, force: true });
  const staged = stageRelease({ version, tag: releaseTag(version), repo: repoName(), notes: notes.text, now: new Date(), from: dir, to });
  const frozen = frozenLatestJson({ kind, version, given, dir: join(root, ".release-frozen"), gh });
  console.error(`release: carrying over the latest.json that announces ${frozen.version}, unchanged`);
  const { dmg } = publish({
    kind,
    version,
    versioned: staged.versioned,
    rolling: staged.rolling,
    manifest: staged.manifest,
    frozen: frozen.path,
    sha,
    notesFile: notes.file,
    repo: repoName(),
    downloadDir: join(root, ".release-shipped"),
    gh,
  });
  console.error(`release: published ${kind} ${version}`);
  output({ dmg });
}

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
      case "desktop-json":
        process.stdout.write(cmdDesktopJson(args[0] ?? "", args[1] ?? "."));
        break;
      case "publish":
        cmdPublish(args[0] ?? "", args[1] ?? "", args[2] ?? "", args[3]);
        break;
      case "prune-nightly": {
        const gone = pruneNightly(args[0] ?? "", gh, join(root, ".release-frozen"));
        console.error(`release: removed ${gone.length} earlier nightly file${gone.length === 1 ? "" : "s"}`);
        break;
      }
      default:
        console.error(
          "usage: bun run release plan | version stable [sha] | version nightly <run> | draft <version> | set <version> | notes [version] | desktop-json <version> <dir> | publish <stable|nightly> <version> <dir> [latest.json to carry over] | prune-nightly <version>",
        );
        process.exit(2);
    }
  } catch (err) {
    console.error(`release: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
