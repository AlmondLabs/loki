import { execFile } from "node:child_process";
import type { MemoryRepos } from "../daemon/memory-sync.ts";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { memoryLog, memoryRoot, readLocalAgent } from "./agents.ts";
import { globalSkillsDir } from "./skills.ts";
import { log } from "./log.ts";
import type { MemoryCommit, MemorySkill, MemorySkillInfo, RefreshOutcome, SkillOrigin, SkillSource } from "../core/frame-types.ts";
import { messageOf } from "../core/errors.ts";
import { writeJsonAtomic } from "./json-file.ts";

export interface SkillSourcesOptions {
  backendDir?: string;
  globalDir?: string;
  lockFile?: string;
  /** state/skill-sources.json: sources the user typed, by "<agentId>/<name>" then "<name>". */
  sourcesFile: string;
  stagingDir: string;
  serial: MemoryRepos["serial"];
  exec?: (bin: string, args: string[], opts: { cwd?: string; timeoutMs: number }) => Promise<string>;
}

export const INSTALL_RE = /^(Install skill: |chore\(skills\): (install|refresh) )/;

const DEFAULT_LOCK = join(homedir(), ".agents", ".skill-lock.json");

export function machineWord(os: NodeJS.Platform = process.platform): string {
  return os === "darwin" ? "this Mac" : os === "win32" ? "this PC" : "this computer";
}

export class SkillSources {
  private readonly opts: SkillSourcesOptions;
  private readonly exec: NonNullable<SkillSourcesOptions["exec"]>;
  constructor(opts: SkillSourcesOptions) {
    this.opts = opts;
    this.exec = opts.exec ?? defaultExec;
  }

  async annotate(agentId: string, skills: MemorySkill[]): Promise<MemorySkillInfo[]> {
    let commits: MemoryCommit[] = [];
    try {
      commits = await memoryLog(agentId, { path: "skills", limit: 200 }, this.opts.backendDir);
    } catch {}
    const global = this.opts.globalDir ?? globalSkillsDir();
    return skills.map((s) => {
      const own = commits.filter((c) => c.files.some((f) => f.startsWith(`skills/${s.name}/`)));
      const installed = own.some((c) => INSTALL_RE.test(c.message));
      const namesake = own.length === 0 && existsSync(join(global, s.name, "SKILL.md"));
      const origin: SkillOrigin = installed || namesake ? "other" : "self";
      const edited = own.length > 0 && !INSTALL_RE.test(own[0].message);
      return { ...s, origin, edited, source: origin === "other" ? this.sourceOf(agentId, s.name) : null };
    });
  }

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
    } catch {}
    const locked = readLock(this.opts.lockFile ?? DEFAULT_LOCK).find((e) => e.name === name);
    if (locked) return { kind: "github", url: locked.sourceUrl, path: dirname(locked.skillPath), ref: null, label: locked.source };
    return null;
  }

  describeGlobal(g: { name: string; path: string; is_link: boolean }): string | null {
    if (g.is_link) return localSource(g.path).label;
    const locked = readLock(this.opts.lockFile ?? DEFAULT_LOCK).find((e) => e.name === g.name);
    return locked ? locked.source : null;
  }

  remember(agentId: string, name: string, spec: string): SkillSource {
    const parsed = parseSource(spec);
    if (!parsed) throw new Error(`a source is a GitHub URL, owner/repo/path, or a folder on ${machineWord()}`);
    const all = this.readSources();
    all[`${agentId}/${name}`] = spec.trim();
    try {
      writeJsonAtomic(this.opts.sourcesFile, all, { pretty: true, newline: true, pidTemp: true });
    } catch (err) {
      log.error("skills:sources-write-failed", messageOf(err));
    }
    return parsed;
  }

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
      return { outcome: "reconcile", label: source.label, changed, upstream_path: stage, prompt: reconcilePrompt(name, source.label, stage, changed) };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  private async fetch(source: SkillSource, tmp: string): Promise<string> {
    let dir: string;
    if (source.kind === "checkout") {
      try {
        await this.exec("git", ["pull", "--ff-only", "--quiet"], { cwd: source.repo, timeoutMs: 30_000 });
      } catch (err) {
        log.error("skills:pull-failed", { repo: source.repo, error: messageOf(err) });
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

  private replace(agentId: string, memory: string, name: string, upstream: string, label: string): Promise<string | null> {
    return this.opts.serial(memory, () => this.replaceNow(agentId, memory, name, upstream, label));
  }

  private async replaceNow(agentId: string, memory: string, name: string, upstream: string, label: string): Promise<string | null> {
    const target = join(memory, "skills", name);
    const spec = `skills/${name}`;
    rmSync(target, { recursive: true, force: true });
    cpSync(upstream, target, { recursive: true, filter: keep });
    if (!existsSync(join(memory, ".git"))) return null;
    const who = readLocalAgent(agentId, this.opts.backendDir)?.name.trim() || "loki";
    try {
      await this.exec("git", ["add", "-A", "--", spec], { cwd: memory, timeoutMs: 10_000 });
      await this.exec(
        "git",
        [
          "-c",
          `user.name=${who}`,
          "-c",
          `user.email=${agentId}@loki.local`,
          "commit",
          "--quiet",
          "-m",
          `chore(skills): refresh ${name} from ${label}`,
          "--",
          spec,
        ],
        { cwd: memory, timeoutMs: 15_000 },
      );
      return (await this.exec("git", ["rev-parse", "HEAD"], { cwd: memory, timeoutMs: 5_000 })).trim();
    } catch (err) {
      await this.exec("git", ["reset", "--quiet", "--", spec], { cwd: memory, timeoutMs: 10_000 }).catch(() => "");
      await this.exec("git", ["checkout", "--quiet", "--", spec], { cwd: memory, timeoutMs: 10_000 }).catch(() => "");
      await this.exec("git", ["clean", "-fdq", "--", spec], { cwd: memory, timeoutMs: 10_000 }).catch(() => "");
      throw new Error(`could not commit the refreshed skill: ${messageOf(err)}`);
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

export function reconcilePrompt(name: string, label: string, upstreamPath: string, changed: string[]): string {
  const list = changed.length > 12 ? `${changed.slice(0, 12).join(", ")} and ${changed.length - 12} more` : changed.join(", ");
  return [
    `Your skill \`${name}\` has a newer upstream version (${label}). I put it at ${upstreamPath}.`,
    `Your copy is skills/${name}/ in your memory, and you have changed it since it was installed. Upstream differs in: ${list}.`,
    `Reconcile the two: keep what you learned, take what upstream improved, and keep SKILL.md's frontmatter to name and description. Write the result over skills/${name}/ — bring references/, scripts/ and any other folders along — then commit.`,
  ].join("\n\n");
}

export function parseSource(spec: string): SkillSource | null {
  const s = spec.trim();
  if (!s || /\s/.test(s)) return null;
  if (isAbsolute(s) || s.startsWith("~") || s.startsWith(".")) {
    const p = s.startsWith("~") ? join(homedir(), s.slice(1)) : resolve(s);
    return existsSync(p) ? localSource(p) : null;
  }
  const url = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.*))?)?\/?$/i.exec(s);
  if (url)
    return {
      kind: "github",
      url: `https://github.com/${url[1]}/${url[2]}.git`,
      path: url.at(4) ?? ".",
      ref: url.at(3) ?? null,
      label: `${url[1]}/${url[2]}${url[4] ? `/${url[4]}` : ""}`,
    };
  const short = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/(.+))?$/.exec(s);
  if (short && !short[1].includes("."))
    return { kind: "github", url: `https://github.com/${short[1]}/${short[2]}.git`, path: short.at(3) ?? ".", ref: null, label: s };
  return null;
}

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
    const list: unknown[] = Array.isArray(raw)
      ? raw
      : typeof raw === "object" && raw !== null
        ? Object.entries(raw).map(([name, v]) => (typeof v === "object" && v !== null ? { name, ...(v as object) } : null))
        : [];
    return list.filter(
      (e): e is LockEntry =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as LockEntry).name === "string" &&
        typeof (e as LockEntry).sourceUrl === "string" &&
        typeof (e as LockEntry).skillPath === "string" &&
        typeof (e as LockEntry).source === "string",
    );
  } catch {
    return [];
  }
}

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
    execFile(
      bin,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (err, stdout, stderr) => (err ? rej(new Error((stderr || err.message).trim().split("\n").slice(-3).join(" "))) : res(stdout)),
    );
  });
}
