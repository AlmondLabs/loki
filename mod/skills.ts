import { execFile } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Skills outside an agent's memory: the global folder Letta reads for every agent
 * (~/.letta/skills, entries are usually symlinks made by skill_enable), and installing a skill
 * into an agent from a source the CLI understands (`letta install <source> --agent <id>`), which
 * has no app-server request. Per-agent skills themselves are files in the memory repo (agents.ts).
 */

export interface GlobalSkill {
  name: string;
  /** Where the folder really is (the link target), or the folder itself. */
  path: string;
  isLink: boolean;
  description: string | null;
  /** Where it came from, when known (mod/skill-sources.ts describeGlobal): the checkout a link points into, or the repo the `skills` CLI recorded. */
  source?: string | null;
}

export const globalSkillsDir = (): string => process.env.LETTA_HOME ? join(process.env.LETTA_HOME, "skills") : join(homedir(), ".letta", "skills");

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

/** A source the CLI accepts: a URL, `owner/repo/path`, `official/<path>`, `clawhub/<slug>`, or a local path. */
export function validSkillSource(source: string): string | null {
  const s = source.trim();
  if (!s) return "a source is required";
  if (/\s/.test(s)) return "a source has no spaces";
  if (s.startsWith("-")) return "a source cannot start with -";
  return null;
}

/** The CLI arguments for one install, without the binary. Exported for tests. */
export function installArgs(source: string, agentId: string, opts: { force?: boolean } = {}): string[] {
  const args = ["install", source.trim(), "--agent", agentId];
  if (opts.force) args.push("--force");
  return args;
}

export function lettaBinary(): string | null {
  const onPath = (process.env.PATH ?? "").split(":").filter(Boolean).map((d) => join(d, "letta"));
  const candidates = [process.env.LOKI_LETTA_BIN, ...onPath, join(homedir(), ".volta", "bin", "letta"), join(homedir(), ".bun", "bin", "letta"), "/opt/homebrew/bin/letta", "/usr/local/bin/letta"].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(p)) ?? null;
}

export type Runner = (args: string[]) => Promise<string>;

/** Run `letta install`; resolves to the CLI's output, rejects with its message. */
export function installSkill(source: string, agentId: string, opts: { force?: boolean; run?: Runner } = {}): Promise<string> {
  const bad = validSkillSource(source);
  if (bad) return Promise.reject(new Error(bad));
  const run: Runner =
    opts.run ??
    ((args) =>
      new Promise((resolve, reject) => {
        const bin = lettaBinary();
        if (!bin) return reject(new Error("letta CLI not found"));
        execFile(bin, args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, CI: "1" } }, (err, stdout, stderr) => {
          if (err) reject(new Error(String(stderr || stdout || err.message).trim().split("\n").slice(-3).join(" ")));
          else resolve(String(stdout).trim());
        });
      }));
  return run(installArgs(source, agentId, opts));
}
