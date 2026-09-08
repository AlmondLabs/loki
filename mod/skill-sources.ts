import { execFile } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { memoryLog, memoryRoot, readLocalAgent, type MemoryCommit, type MemorySkill } from "./agents.ts";
import { globalSkillsDir } from "./skills.ts";
import { log } from "./log.ts";

/**
 * Where an agent's skills came from, and how to refresh the ones that came from elsewhere.
 *
 * An agent's memory holds two kinds of skill. *Self*: the agent (or Deepak, in the Agents tab) wrote it;
 * nobody else has a copy, nothing to pull. *Other*: it was installed from somewhere — a GitHub repo, a
 * checkout on this Mac linked into ~/.letta/skills, a `letta install` source — and that somewhere may
 * have moved on. The distinction is read off the memory repo's own history: an install commit
 * (`Install skill: x`, `chore(skills): install x`, or our own `chore(skills): refresh x …`) marks a
 * skill as other; a skill with no such commit but a namesake in the global folder is other too;
 * everything else is self.
 *
 * Refresh, for an other skill: find the upstream (the lock file the `skills` CLI keeps, the checkout a
 * global symlink points into, or a source the user typed once, remembered in state/skill-sources.json),
 * fetch its latest, and compare with the memory copy. Nothing changed → say so. The agent never edited
 * its copy → replace it and commit. The agent did edit it → stage upstream beside the memory and hand
 * the agent a message asking it to reconcile: keep what it learned, take what upstream improved. That
 * last step is the agent's, on purpose: the copy is its memory.
 */

export type SkillOrigin = "self" | "other";

export type SkillSource =
  /** A git checkout on this Mac; refresh pulls it. `rel` is the skill folder inside it. */
  | { kind: "checkout"; repo: string; rel: string; label: string }
  /** A plain folder on this Mac (no git); refresh copies from it. */
  | { kind: "folder"; path: string; label: string }
  /** A GitHub repository; refresh clones it shallowly. `path` is the skill folder inside it. */
  | { kind: "github"; url: string; path: string; ref: string | null; label: string };

export interface SkillProvenance {
  origin: SkillOrigin;
  /** Commits after the last install/refresh: the agent changed its copy. */
  edited: boolean;
  /** Where refresh would fetch from; null for a self skill or an other skill nobody told us the source of. */
  source: SkillSource | null;
}

export type MemorySkillInfo = MemorySkill & SkillProvenance;

export type RefreshOutcome =
  | { outcome: "current"; label: string }
  | { outcome: "replaced"; label: string; changed: string[]; sha: string | null }
  | { outcome: "reconcile"; label: string; changed: string[]; upstreamPath: string; prompt: string };

export interface SkillSourcesOptions {
  /** The local backend (mod/agents.ts backendDir()). */
  backendDir?: string;
  /** ~/.letta/skills (or the folder it links to). */
  globalDir?: string;
  /** The `skills` CLI's lock: ~/.agents/.skill-lock.json. */
  lockFile?: string;
  /** state/skill-sources.json: sources the user typed, by "<agentId>/<name>" then "<name>". */
  sourcesFile: string;
  /** state/upstream: where a fetched upstream is staged for the agent to read. */
  stagingDir: string;
  /** Run git; tests inject. */
  exec?: (bin: string, args: string[], opts: { cwd?: string; timeoutMs: number }) => Promise<string>;
}

/** Commit subjects that mean "this copy came from outside" — Letta's two installers and our refresh. */
export const INSTALL_RE = /^(Install skill: |chore\(skills\): (install|refresh) )/;

const DEFAULT_LOCK = join(process.env.HOME ?? "~", ".agents", ".skill-lock.json");

export class SkillSources {
  private readonly opts: SkillSourcesOptions;
  private readonly exec: NonNullable<SkillSourcesOptions["exec"]>;
  constructor(opts: SkillSourcesOptions) {
    this.opts = opts;
    this.exec = opts.exec ?? defaultExec;
  }

  /** Every memory skill with its origin, whether the agent edited it, and its source when known. */
  async annotate(agentId: string, skills: MemorySkill[]): Promise<MemorySkillInfo[]> {
    let commits: MemoryCommit[] = [];
    try {
      commits = await memoryLog(agentId, { path: "skills", limit: 200 }, this.opts.backendDir);
    } catch {
      // no git: origin falls back to the global folder
    }
    const global = this.opts.globalDir ?? globalSkillsDir();
    return skills.map((s) => {
      const own = commits.filter((c) => c.files.some((f) => f.startsWith(`skills/${s.name}/`)));
      const installed = own.some((c) => INSTALL_RE.test(c.message));
      // No history to read (no git, or the folder was never committed): a namesake in the global folder is the only clue.
      const namesake = own.length === 0 && existsSync(join(global, s.name, "SKILL.md"));
      const origin: SkillOrigin = installed || namesake ? "other" : "self";
      const edited = own.length > 0 && !INSTALL_RE.test(own[0].message);
      return { ...s, origin, edited, source: origin === "other" ? this.sourceOf(agentId, s.name) : null };
    });
  }

  /** The remembered source, else the global folder's link or the lock file. */
  sourceOf(agentId: string, name: string): SkillSource | null {
    const typed = this.readSources();
    const spec = typed[`${agentId}/${name}`] ?? typed[name];
    if (spec) {
      const parsed = parseSource(spec);
      if (parsed) return parsed;
    }
    const global = this.opts.globalDir ?? globalSkillsDir();
    const entry = join(global, name);
    try {
      const st = lstatSync(entry);
      if (st.isSymbolicLink()) {
        const target = resolve(global, readlinkSync(entry));
        return localSource(target);
      }
    } catch {
      // not in the global folder
    }
    const locked = readLock(this.opts.lockFile ?? DEFAULT_LOCK).find((e) => e.name === name);
    if (locked) return { kind: "github", url: locked.sourceUrl, path: dirname(locked.skillPath), ref: null, label: locked.source };
    return null;
  }

  /** Remember a source the user typed for this agent's skill; returns the parsed source or throws. */
  remember(agentId: string, name: string, spec: string): SkillSource {
    const parsed = parseSource(spec);
    if (!parsed) throw new Error("a source is a GitHub URL, owner/repo/path, or a folder on this Mac");
    const all = this.readSources();
    all[`${agentId}/${name}`] = spec.trim();
    try {
      mkdirSync(dirname(this.opts.sourcesFile), { recursive: true });
      const tmp = `${this.opts.sourcesFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n");
      renameSync(tmp, this.opts.sourcesFile);
    } catch (err) {
      log("skills:sources-write-failed", err instanceof Error ? err.message : String(err));
    }
    return parsed;
  }

  /**
   * Fetch upstream, compare, and either replace the untouched copy, stage upstream for the agent to
   * reconcile, or report the copy current. `spec`, when given, is remembered first.
   */
  async refresh(agentId: string, name: string, spec?: string): Promise<RefreshOutcome> {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) throw new Error("not a skill name");
    const memory = memoryRoot(agentId, this.opts.backendDir);
    const mine = join(memory, "skills", name);
    if (!existsSync(join(mine, "SKILL.md"))) throw new Error(`${name} is not in this agent's memory`);
    const source = spec?.trim() ? this.remember(agentId, name, spec) : this.sourceOf(agentId, name);
    if (!source) throw new Error(`no known source for ${name}; give one`);
    const [skills] = [await this.annotate(agentId, [{ name, path: `skills/${name}/SKILL.md`, description: null }])];
    const edited = skills[0]?.edited ?? true;

    const tmp = mkdtempSync(join(tmpdir(), "loki-skill-"));
    try {
      const upstream = await this.fetch(source, tmp);
      const changed = compareTrees(upstream, mine);
      if (changed.length === 0) return { outcome: "current", label: source.label };
      if (!edited) {
        const sha = await this.replace(agentId, memory, name, upstream, source.label);
        log("skills:refreshed", { agentId, name, label: source.label, changed: changed.length, sha });
        return { outcome: "replaced", label: source.label, changed, sha };
      }
      const stage = join(this.opts.stagingDir, agentId, name);
      rmSync(stage, { recursive: true, force: true });
      mkdirSync(dirname(stage), { recursive: true });
      cpSync(upstream, stage, { recursive: true, filter: keep });
      log("skills:staged", { agentId, name, label: source.label, changed: changed.length, stage });
      return { outcome: "reconcile", label: source.label, changed, upstreamPath: stage, prompt: reconcilePrompt(name, source.label, stage, changed) };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** The upstream skill folder, fresh: a pulled checkout, a folder as it is, or a shallow clone in `tmp`. */
  private async fetch(source: SkillSource, tmp: string): Promise<string> {
    let dir: string;
    if (source.kind === "checkout") {
      try {
        await this.exec("git", ["pull", "--ff-only", "--quiet"], { cwd: source.repo, timeoutMs: 30_000 });
      } catch (err) {
        // A dirty or offline checkout still has a working tree worth comparing against.
        log("skills:pull-failed", { repo: source.repo, error: err instanceof Error ? err.message : String(err) });
      }
      dir = join(source.repo, source.rel);
    } else if (source.kind === "folder") {
      dir = source.path;
    } else {
      const clone = join(tmp, "repo");
      const args = ["clone", "--depth", "1", "--quiet", ...(source.ref ? ["--branch", source.ref] : []), source.url, clone];
      await this.exec("git", args, { timeoutMs: 90_000 });
      dir = resolve(clone, source.path);
      if (!dir.startsWith(clone + sep) && dir !== clone) throw new Error("the skill path escapes the repository");
    }
    if (!existsSync(join(dir, "SKILL.md"))) throw new Error(`no SKILL.md at ${source.label}`);
    return dir;
  }

  /** Overwrite the memory copy and commit as the agent, the way `letta install` does. */
  private async replace(agentId: string, memory: string, name: string, upstream: string, label: string): Promise<string | null> {
    const target = join(memory, "skills", name);
    const spec = `skills/${name}`;
    rmSync(target, { recursive: true, force: true });
    cpSync(upstream, target, { recursive: true, filter: keep });
    if (!existsSync(join(memory, ".git"))) return null;
    const who = readLocalAgent(agentId, this.opts.backendDir)?.name?.trim() || "loki";
    try {
      await this.exec("git", ["add", "-A", "--", spec], { cwd: memory, timeoutMs: 10_000 });
      await this.exec("git", ["-c", `user.name=${who}`, "-c", `user.email=${agentId}@letta.com`, "commit", "--quiet", "-m", `chore(skills): refresh ${name} from ${label}`, "--", spec], { cwd: memory, timeoutMs: 15_000 });
      return (await this.exec("git", ["rev-parse", "HEAD"], { cwd: memory, timeoutMs: 5_000 })).trim();
    } catch (err) {
      // The hook refused, or git did: put the copy back as it was and say why.
      await this.exec("git", ["reset", "--quiet", "--", spec], { cwd: memory, timeoutMs: 10_000 }).catch(() => "");
      await this.exec("git", ["checkout", "--quiet", "--", spec], { cwd: memory, timeoutMs: 10_000 }).catch(() => "");
      await this.exec("git", ["clean", "-fdq", "--", spec], { cwd: memory, timeoutMs: 10_000 }).catch(() => "");
      throw new Error(`could not commit the refreshed skill: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private readSources(): Record<string, string> {
    try {
      const parsed = JSON.parse(readFileSync(this.opts.sourcesFile, "utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null) return {};
      return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as Record<string, string>;
    } catch {
      return {};
    }
  }
}

/** What the agent is asked when its edited copy and upstream differ. Exported so the wording is tested. */
export function reconcilePrompt(name: string, label: string, upstreamPath: string, changed: string[]): string {
  const list = changed.length > 12 ? `${changed.slice(0, 12).join(", ")} and ${changed.length - 12} more` : changed.join(", ");
  return [
    `Your skill \`${name}\` has a newer upstream version (${label}). I put it at ${upstreamPath}.`,
    `Your copy is skills/${name}/ in your memory, and you have changed it since it was installed. Upstream differs in: ${list}.`,
    `Reconcile the two: keep what you learned, take what upstream improved, and keep SKILL.md's frontmatter to name and description. Write the result over skills/${name}/ — bring references/, scripts/ and any other folders along — then commit.`,
  ].join("\n\n");
}

/**
 * A typed source: `https://github.com/o/r`, `https://github.com/o/r/tree/<ref>/<path>`, `o/r`, `o/r/<path>`,
 * or a folder on this Mac (`/…`, `~/…`, `./…`). Null when it is none of these.
 */
export function parseSource(spec: string): SkillSource | null {
  const s = spec.trim();
  if (!s || /\s/.test(s)) return null;
  if (s.startsWith("/") || s.startsWith("~") || s.startsWith(".")) {
    const p = s.startsWith("~") ? join(process.env.HOME ?? "", s.slice(1)) : resolve(s);
    return existsSync(p) ? localSource(p) : null;
  }
  const url = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.*))?)?\/?$/i.exec(s);
  if (url) return { kind: "github", url: `https://github.com/${url[1]}/${url[2]}.git`, path: url[4] ?? ".", ref: url[3] ?? null, label: `${url[1]}/${url[2]}${url[4] ? `/${url[4]}` : ""}` };
  const short = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/(.+))?$/.exec(s);
  if (short && !short[1].includes(".")) return { kind: "github", url: `https://github.com/${short[1]}/${short[2]}.git`, path: short[3] ?? ".", ref: null, label: s };
  return null;
}

/** A folder on this Mac: the git checkout it sits in (then refresh can pull), or the folder itself. */
export function localSource(path: string): SkillSource {
  const repo = gitRoot(path);
  if (repo) return { kind: "checkout", repo, rel: relative(repo, path) || ".", label: `${basename(repo)} checkout` };
  return { kind: "folder", path, label: `${basename(path)} folder` };
}

function gitRoot(path: string): string | null {
  let dir = resolve(path);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

interface LockEntry {
  name: string;
  source: string;
  sourceUrl: string;
  skillPath: string;
}

/**
 * The `skills` CLI's lock file (~/.agents/.skill-lock.json, version 3): `skills` is an object keyed by skill
 * name, each `{ source, sourceType, sourceUrl, skillPath, … }`; an array of the same with a `name` field is
 * read too.
 */
export function readLock(file: string): LockEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { skills?: unknown };
    const raw = parsed.skills;
    const list: unknown[] = Array.isArray(raw) ? raw : typeof raw === "object" && raw !== null ? Object.entries(raw as Record<string, unknown>).map(([name, v]) => (typeof v === "object" && v !== null ? { name, ...(v as object) } : null)) : [];
    return list.filter((e): e is LockEntry => typeof e === "object" && e !== null && typeof (e as LockEntry).name === "string" && typeof (e as LockEntry).sourceUrl === "string" && typeof (e as LockEntry).skillPath === "string" && typeof (e as LockEntry).source === "string");
  } catch {
    return [];
  }
}

/** Files that differ between two skill folders (added, removed or changed), as paths relative to them. */
export function compareTrees(a: string, b: string): string[] {
  const fa = listFiles(a);
  const fb = listFiles(b);
  const out = new Set<string>();
  for (const f of fa) if (!fb.has(f) || !readFileSync(join(a, f)).equals(readFileSync(join(b, f)))) out.add(f);
  for (const f of fb) if (!fa.has(f)) out.add(f);
  return [...out].sort();
}

function listFiles(root: string, rel = "", out = new Set<string>()): Set<string> {
  let entries: string[];
  try {
    entries = readdirSync(join(root, rel));
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === ".git" || e === ".DS_Store") continue;
    const r = rel ? `${rel}/${e}` : e;
    const st = statSync(join(root, r));
    if (st.isDirectory()) listFiles(root, r, out);
    else if (st.isFile()) out.add(r);
  }
  return out;
}

const keep = (p: string) => basename(p) !== ".git" && basename(p) !== ".DS_Store";

function defaultExec(bin: string, args: string[], opts: { cwd?: string; timeoutMs: number }): Promise<string> {
  return new Promise((res, rej) => {
    execFile(bin, args, { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout, stderr) => (err ? rej(new Error(String(stderr || err.message).trim().split("\n").slice(-3).join(" "))) : res(String(stdout))));
  });
}
