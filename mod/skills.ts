import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { execProgram } from "./programs.ts";
import { memoryRoot } from "./agents.ts";
import type { GlobalSkill } from "../core/frame-types.ts";

export const globalSkillsDir = (): string => process.env.LOKI_SKILLS_DIR ?? join(homedir(), ".agents", "skills");

export function skillDescription(text: string): string | null {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  const d = fm?.[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (d) return d.replace(/^["']|["']$/g, "");
  return /^#+\s*(.+)$/m.exec(text.replace(/^---[\s\S]*?---/, ""))?.[1]?.trim() ?? null;
}

const BRIEF_LIMIT = 200;

export function briefDescription(description: string): string {
  const text = description.trim().replace(/\s+/g, " ");
  if (text.length <= BRIEF_LIMIT) return text;
  const cut = text.slice(0, BRIEF_LIMIT - 1);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : cut.length).trimEnd()}…`;
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
    } catch {}
    out.push({ name, path: target, is_link: isLink, description });
  }
  return out;
}

export function validSkillSource(source: string): string | null {
  const s = source.trim();
  if (!s) return "a source is required";
  if (/\s/.test(s)) return "a source has no spaces";
  if (s.startsWith("-")) return "a source cannot start with -";
  return null;
}

export type SkillOrigin = { kind: "folder"; path: string } | { kind: "git"; url: string; ref: string | null; path: string };

export function skillOrigin(source: string, home = homedir()): SkillOrigin {
  const s = source.trim();
  if (s.startsWith("/") || s.startsWith("~") || s.startsWith(".") || /^[A-Za-z]:[\\/]/.test(s))
    return { kind: "folder", path: resolve(s.replace(/^~(?=$|[\\/])/, home)) };
  const web = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+)(?:\/(.*))?)?\/?$/.exec(s);
  if (web)
    return { kind: "git", url: `https://github.com/${web[1]}/${web[2]}.git`, ref: web.at(3) ?? null, path: (web.at(4) ?? "").replace(/\/SKILL\.md$/, "") };
  if (/^(https?|git|ssh):\/\/|^git@/.test(s)) return { kind: "git", url: s, ref: null, path: "" };
  const [owner, repo, ...rest] = s.split("/");
  if (!owner || !repo) throw new Error("a source is a GitHub path (owner/repo/path), a git URL, or a folder");
  return { kind: "git", url: `https://github.com/${owner}/${repo}.git`, ref: null, path: rest.join("/") };
}

export type Runner = (program: string, args: string[], cwd?: string) => Promise<string>;

const runProgram: Runner = (program, args, cwd) =>
  new Promise((done, fail) => {
    execProgram(program, args, { cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) fail(new Error((stderr || stdout || err.message).trim().split("\n").slice(-3).join(" ")));
      else done(stdout.trim());
    });
  });

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
    if (!existsSync(join(folder, "SKILL.md")))
      throw new Error(`no SKILL.md in ${origin.kind === "folder" ? folder : `${origin.url}${origin.path ? ` at ${origin.path}` : ""}`}`);
    const name = basename(folder) === "repo" && origin.kind === "git" ? basename(origin.url, ".git") : basename(folder);
    const target = join(memory, "skills", name);
    if (existsSync(target) && !opts.force) throw new Error(`the agent already has a skill named ${name}; install again with force to replace it`);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(dirname(target), { recursive: true });
    cpSync(folder, target, { recursive: true, filter: (p) => basename(p) !== ".git" });
    await run("git", ["add", "--all", join("skills", name)], memory);
    if (!(await run("git", ["status", "--porcelain", "--", join("skills", name)], memory)).trim())
      return `${name} is already installed as it is at ${source.trim()}`;
    await run("git", ["commit", "--quiet", "-m", `Install skill: ${name}`, "--", join("skills", name)], memory);
    return `installed ${name} from ${source.trim()}`;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
