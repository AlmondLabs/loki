import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { execProgram } from "./programs.ts";
import { memoryRoot } from "./agents.ts";
import type { GlobalSkill } from "../core/frame-types.ts";

/**
 * Skills outside an agent's memory: the global folder every agent reads (~/.agents/skills, the folder agent tools
 * share; entries are usually links made by skill_enable), and installing a skill into an agent. Per-agent skills
 * themselves are files in the memory repo (agents.ts).
 */

export const globalSkillsDir = (): string => process.env.LOKI_SKILLS_DIR ?? join(homedir(), ".agents", "skills");

/** The first line worth showing from a SKILL.md: its frontmatter description, else its first heading. */
export function skillDescription(text: string): string | null {
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  const d = fm?.[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (d) return d.replace(/^["']|["']$/g, "");
  return text.replace(/^---[\s\S]*?---/, "").match(/^#+\s*(.+)$/m)?.[1]?.trim() ?? null;
}

export function listGlobalSkills(dir = globalSkillsDir()): GlobalSkill[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: GlobalSkill[] = [];
  for (const name of names.sort()) {
    if (name.startsWith(".")) continue;
    const p = join(dir, name);
    let isLink = false;
    let target = p;
    try {
      const st = lstatSync(p);
      isLink = st.isSymbolicLink();
      if (isLink) target = resolve(dir, readlinkSync(p));
    } catch {
      continue;
    }
    const md = join(target, "SKILL.md");
    if (!existsSync(md)) continue;
    let description: string | null = null;
    try {
      description = skillDescription(readFileSync(md, "utf8"));
    } catch {
      // name only
    }
    out.push({ name, path: target, isLink, description });
  }
  return out;
}

/** A source loki installs from: a GitHub path (`owner/repo[/path]`), a GitHub or git URL, or a folder on this machine. */
export function validSkillSource(source: string): string | null {
  const s = source.trim();
  if (!s) return "a source is required";
  if (/\s/.test(s)) return "a source has no spaces";
  if (s.startsWith("-")) return "a source cannot start with -";
  return null;
}

/** Where a source's files come from: a folder here, or a repository to clone (at a branch) and the folder in it. */
export type SkillOrigin = { kind: "folder"; path: string } | { kind: "git"; url: string; ref: string | null; path: string };

export function skillOrigin(source: string, home = homedir()): SkillOrigin {
  const s = source.trim();
  if (s.startsWith("/") || s.startsWith("~") || s.startsWith(".") || /^[A-Za-z]:[\\/]/.test(s)) return { kind: "folder", path: resolve(s.replace(/^~(?=$|[\\/])/, home)) };
  const web = s.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+)(?:\/(.*))?)?\/?$/);
  if (web) return { kind: "git", url: `https://github.com/${web[1]}/${web[2]}.git`, ref: web[3] ?? null, path: (web[4] ?? "").replace(/\/SKILL\.md$/, "") };
  if (/^(https?|git|ssh):\/\/|^git@/.test(s)) return { kind: "git", url: s, ref: null, path: "" };
  const [owner, repo, ...rest] = s.split("/");
  if (!owner || !repo) throw new Error("a source is a GitHub path (owner/repo/path), a git URL, or a folder");
  return { kind: "git", url: `https://github.com/${owner}/${repo}.git`, ref: null, path: rest.join("/") };
}

export type Runner = (program: string, args: string[], cwd?: string) => Promise<string>;

const runProgram: Runner = (program, args, cwd) =>
  new Promise((done, fail) => {
    execProgram(program, args, { cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) fail(new Error(String(stderr || stdout || err.message).trim().split("\n").slice(-3).join(" ")));
      else done(String(stdout).trim());
    });
  });

/**
 * Install a skill into an agent's memory: its folder (one with a SKILL.md) copied to `skills/<name>` in the memory repo
 * and committed, where the agent's skills section finds it. A skill of that name already there is replaced only with
 * `force`. Resolves to a line saying what was installed.
 */
export async function installSkill(source: string, agentId: string, opts: { force?: boolean; run?: Runner; memory?: string } = {}): Promise<string> {
  const bad = validSkillSource(source);
  if (bad) throw new Error(bad);
  const run = opts.run ?? runProgram;
  const origin = skillOrigin(source);
  const memory = opts.memory ?? memoryRoot(agentId);
  const scratch = mkdtempSync(join(tmpdir(), "loki-skill-"));
  try {
    let folder = origin.kind === "folder" ? origin.path : join(scratch, "repo", origin.path);
    if (origin.kind === "git") await run("git", ["clone", "--depth", "1", ...(origin.ref ? ["--branch", origin.ref] : []), origin.url, join(scratch, "repo")]);
    folder = resolve(folder);
    if (!existsSync(join(folder, "SKILL.md"))) throw new Error(`no SKILL.md in ${origin.kind === "folder" ? folder : `${origin.url}${origin.path ? ` at ${origin.path}` : ""}`}`);
    const name = basename(folder) === "repo" && origin.kind === "git" ? basename(origin.url, ".git") : basename(folder);
    const target = join(memory, "skills", name);
    if (existsSync(target) && !opts.force) throw new Error(`the agent already has a skill named ${name}; install again with force to replace it`);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(dirname(target), { recursive: true });
    cpSync(folder, target, { recursive: true, filter: (p) => basename(p) !== ".git" });
    await run("git", ["add", "--all", join("skills", name)], memory);
    // The same skill installed again changes nothing, and is not a commit.
    if (!(await run("git", ["status", "--porcelain", "--", join("skills", name)], memory)).trim()) return `${name} is already installed as it is at ${source.trim()}`;
    await run("git", ["commit", "--quiet", "-m", `Install skill: ${name}`, "--", join("skills", name)], memory);
    return `installed ${name} from ${source.trim()}`;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
