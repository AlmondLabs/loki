import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { backendName } from "../shared/desk-core.ts";

/**
 * What Letta keeps per agent on this machine, read for the Agents page:
 *   <backend>/agents/<b64 id>.json          the record: name, description, model, settings, tags
 *   <backend>/memfs/<id>/memory/            the memory filesystem — a git repo: system/{persona,human}.md,
 *                                           reference/**, skills/<name>/SKILL.md, profile.png
 * Everything here is read-only. Changing the record goes through the app-server (agent_update);
 * changing memory is the agent's job, which the page hands over to the chat.
 */

export const backendDir = (): string => process.env.LOKI_BACKEND_DIR ?? join(homedir(), ".letta", "lc-local-backend");

export interface LocalAgent {
  id: string;
  name: string;
  description: string | null;
  model: string | null;
  /** Provider, effort, thinking, context window… as Letta stores them. */
  modelSettings: Record<string, unknown>;
  tags: string[];
  favourite: boolean;
  /** The first line of the system prompt, for orientation; the prompt is Letta Code's, not editable here. */
  systemHead: string | null;
}

export interface MemoryFile {
  path: string;
  bytes: number;
  modifiedAt: string;
}

export interface MemorySkill {
  name: string;
  path: string;
  /** From the SKILL.md frontmatter, or its first heading. */
  description: string | null;
}

export interface MemoryCommit {
  sha: string;
  message: string;
  at: string;
  files: string[];
}

export function readLocalAgent(agentId: string, dir = backendDir()): LocalAgent | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, "agents", `${backendName(agentId)}.json`), "utf8")) as Record<string, unknown>;
    const tags = Array.isArray(raw.tags) ? (raw.tags as unknown[]).filter((t): t is string => typeof t === "string") : [];
    const system = typeof raw.system === "string" ? raw.system : "";
    return {
      id: agentId,
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : agentId,
      description: typeof raw.description === "string" && raw.description.trim() ? raw.description.trim() : null,
      model: typeof raw.model === "string" ? raw.model : null,
      modelSettings: raw.model_settings && typeof raw.model_settings === "object" ? (raw.model_settings as Record<string, unknown>) : {},
      tags,
      favourite: tags.some((t) => t.startsWith("favorite:")),
      systemHead: system ? system.split("\n")[0].slice(0, 200) : null,
    };
  } catch {
    return null;
  }
}

export function memoryRoot(agentId: string, dir = backendDir()): string {
  return join(dir, "memfs", agentId, "memory");
}

export function profilePath(agentId: string, dir = backendDir()): string | null {
  const p = join(memoryRoot(agentId, dir), "profile.png");
  return existsSync(p) ? p : null;
}

const SKIP = new Set([".git", "node_modules"]);

/** Every file under the memory root except git internals, relative paths with forward slashes, system files first. */
export function memoryTree(agentId: string, dir = backendDir()): MemoryFile[] {
  const root = memoryRoot(agentId, dir);
  if (!existsSync(root)) return [];
  const out: MemoryFile[] = [];
  const walk = (abs: string) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
      const p = join(abs, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const st = statSync(p);
        out.push({ path: relative(root, p).split(sep).join("/"), bytes: st.size, modifiedAt: st.mtime.toISOString() });
      }
    }
  };
  walk(root);
  const rank = (p: string) => (p.startsWith("system/") ? 0 : p.startsWith("reference/") ? 1 : p.startsWith("skills/") ? 2 : 3);
  return out.sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path));
}

/** Skills the agent keeps in its memory: skills/<name>/SKILL.md, with the frontmatter description. */
export function memorySkills(agentId: string, dir = backendDir()): MemorySkill[] {
  return memoryTree(agentId, dir)
    .filter((f) => /^skills\/[^/]+\/SKILL\.md$/.test(f.path))
    .map((f) => {
      const name = f.path.split("/")[1];
      let description: string | null = null;
      try {
        const text = readFileSync(join(memoryRoot(agentId, dir), f.path), "utf8");
        const fm = text.match(/^---\n([\s\S]*?)\n---/);
        const d = fm?.[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
        description = d ? d.replace(/^["']|["']$/g, "") : (text.replace(/^---[\s\S]*?---/, "").match(/^#+\s*(.+)$/m)?.[1]?.trim() ?? null);
      } catch {
        // unreadable: name only
      }
      return { name, path: f.path, description };
    });
}

/** A memory file's text, or null when the path escapes the root, is not a file, or is too large or binary. */
export function readMemoryFile(agentId: string, path: string, dir = backendDir(), limit = 512 * 1024): string | null {
  const root = resolve(memoryRoot(agentId, dir));
  const abs = resolve(root, path);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  try {
    const st = statSync(abs);
    if (!st.isFile() || st.size > limit) return null;
    const buf = readFileSync(abs);
    if (buf.subarray(0, 512).includes(0)) return null; // binary
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((res, rej) => {
    execFile("git", args, { cwd, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => (err ? rej(new Error(String(stderr || err.message).trim())) : res(stdout)));
  });
}

/** `git log` on the memory repo: what the agent learned, newest first, with the files each commit touched. */
export async function memoryLog(agentId: string, opts: { path?: string; limit?: number } = {}, dir = backendDir()): Promise<MemoryCommit[]> {
  const root = memoryRoot(agentId, dir);
  if (!existsSync(join(root, ".git"))) return [];
  const args = ["log", `-n${Math.max(1, Math.min(200, opts.limit ?? 40))}`, "--format=%x1e%H%x1f%s%x1f%cI", "--name-only"];
  if (opts.path) args.push("--", opts.path);
  const out = await git(args, root);
  return parseGitLog(out);
}

/** Parses the --format=%x1e%H%x1f%s%x1f%cI --name-only output. Exported for tests. */
export function parseGitLog(out: string): MemoryCommit[] {
  return out
    .split("\x1e")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [head, ...rest] = chunk.split("\n");
      const [sha = "", message = "", at = ""] = head.split("\x1f");
      return { sha, message, at, files: rest.map((l) => l.trim()).filter(Boolean) };
    });
}

/** One commit's diff, without colour, capped so a runaway reflection cannot flood the page. */
export async function memoryDiff(agentId: string, sha: string, dir = backendDir()): Promise<string> {
  if (!/^[0-9a-f]{6,40}$/i.test(sha)) throw new Error("not a commit sha");
  const out = await git(["show", sha, "--format=%s%n%cI%n", "--no-color", "--stat=80", "-p"], memoryRoot(agentId, dir));
  return out.length > 200_000 ? `${out.slice(0, 200_000)}\n… (diff truncated)` : out;
}

// --- permission modes ------------------------------------------------------------------------------
/**
 * Letta persists each conversation's permission mode in ~/.letta/remote-settings.json under
 * permissionModeMap, keyed "conversation:<id>" (or "agent:<id>::conversation:default" for a main
 * chat). Entries equal to the default are not written, and the default is "unrestricted".
 */
export type PermissionMode = "strict" | "standard" | "acceptEdits" | "unrestricted";
export const DEFAULT_PERMISSION_MODE: PermissionMode = "unrestricted";

export function permissionModeKey(agentId: string | null, conversationId: string): string {
  return conversationId === "default" ? `agent:${agentId ?? "__unknown__"}::conversation:default` : `conversation:${conversationId}`;
}

export function readPermissionModes(file = join(homedir(), ".letta", "remote-settings.json")): Record<string, PermissionMode> {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { permissionModeMap?: Record<string, { mode?: string }> };
    const out: Record<string, PermissionMode> = {};
    for (const [k, v] of Object.entries(raw.permissionModeMap ?? {})) {
      const m = v?.mode;
      if (m === "strict" || m === "standard" || m === "acceptEdits" || m === "unrestricted") out[k] = m;
    }
    return out;
  } catch {
    return {};
  }
}

export function permissionModeOf(agentId: string | null, conversationId: string, file?: string): PermissionMode {
  return readPermissionModes(file)[permissionModeKey(agentId, conversationId)] ?? DEFAULT_PERMISSION_MODE;
}
