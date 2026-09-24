import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";

/**
 * Working folders for "new desk": where recent conversations ran (per agent),
 * path completion against the disk, a validity check with the git branch, and
 * the native macOS folder chooser — none of which the browser can do itself.
 */

/** Windows paths take `\\` as well as `/` (`C:\\Users\\x`, `~\\proj`); elsewhere a backslash is part of a name. */
const IS_WINDOWS = process.platform === "win32";

/** Expand a leading ~ (and, on Windows, ~\\) and resolve. `windows` picks the separators, so tests can run either way. */
export function expandPath(p: string, home = homedir(), windows = IS_WINDOWS): string {
  const path = windows ? win32 : posix;
  const t = p.trim();
  const rest = t.startsWith("~") ? t.slice(1) : null;
  if (rest === "") return home;
  if (rest !== null && (rest.startsWith("/") || (windows && rest.startsWith("\\")))) return path.resolve(home, rest.slice(1));
  return path.resolve(t);
}

/** The first `bytes` of a file as text (a transcript's session line is at the top). */
function head(path: string, bytes = 4096): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export interface RecentFolders {
  /** agentId → folders, most recently used first. */
  byAgent: Record<string, string[]>;
  /** conversationDirName → folder, for the desk you are on. */
  byConversation: Record<string, string>;
}

/**
 * Scan the local backend: each conversation's transcript starts with a session
 * line carrying its cwd; conversation.json gives the agent and recency.
 */
export function recentFolders(backendDir = join(homedir(), ".letta", "lc-local-backend")): RecentFolders {
  const root = join(backendDir, "conversations");
  const byAgent: Record<string, Array<{ at: string; cwd: string }>> = {};
  const byConversation: Record<string, string> = {};
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root);
  } catch {
    return { byAgent: {}, byConversation: {} };
  }
  for (const d of dirs) {
    try {
      const meta = JSON.parse(readFileSync(join(root, d, "conversation.json"), "utf8")) as { agent_id?: string; last_message_at?: string | null; archived?: boolean };
      const first = head(join(root, d, "messages.jsonl")).split("\n")[0] ?? "";
      const session = JSON.parse(first) as { type?: string; cwd?: string };
      if (session.type !== "session" || typeof session.cwd !== "string" || !session.cwd) continue;
      byConversation[d] = session.cwd;
      if (!meta.agent_id) continue;
      (byAgent[meta.agent_id] ??= []).push({ at: meta.last_message_at ?? "", cwd: session.cwd });
    } catch {
      // not every directory is a full conversation
    }
  }
  const out: Record<string, string[]> = {};
  for (const [agent, list] of Object.entries(byAgent)) {
    list.sort((a, b) => b.at.localeCompare(a.at));
    const seen = new Set<string>();
    out[agent] = list.filter((x) => (seen.has(x.cwd) ? false : (seen.add(x.cwd), true))).map((x) => x.cwd);
  }
  return { byAgent: out, byConversation };
}

/** The system a completion runs against: its separators, and how a folder is listed (a fake disk in tests). */
export interface FolderSystem {
  windows: boolean;
  list: (dir: string) => Array<{ name: string; isDirectory: () => boolean }>;
}

const THIS_SYSTEM: FolderSystem = { windows: IS_WINDOWS, list: (dir) => readdirSync(dir, { withFileTypes: true }) };

/** Directories matching what has been typed so far (completes the last path segment). */
export function completeFolder(prefix: string, home = homedir(), limit = 12, system: FolderSystem = THIS_SYSTEM): string[] {
  const path = system.windows ? win32 : posix;
  const raw = prefix.trim();
  if (!raw) return [];
  // Only a path that says where it starts: ~, /, or on Windows a drive (C:\\, C:/).
  const expanded = raw.startsWith("~") ? expandPath(raw, home, system.windows) : path.isAbsolute(raw) ? (system.windows ? path.normalize(raw) : raw) : null;
  if (!expanded) return [];
  const endsWithSlash = system.windows ? /[\\/]$/.test(raw) : raw.endsWith("/");
  const dir = endsWithSlash ? expanded : path.dirname(expanded);
  const partial = endsWithSlash ? "" : expanded.slice(dir.length).replace(system.windows ? /^[\\/]/ : /^\//, "");
  try {
    return system
      .list(dir)
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name.toLowerCase().startsWith(partial.toLowerCase()))
      .map((e) => path.join(dir, e.name))
      .sort()
      .slice(0, limit);
  } catch {
    return [];
  }
}

export interface FolderCheck {
  ok: boolean;
  path: string;
  branch: string | null;
  reason?: string;
}

/** Does the folder exist, and which git branch is checked out there (if any)? */
export function checkFolder(p: string, home = homedir()): FolderCheck {
  const path = expandPath(p, home);
  try {
    if (!statSync(path).isDirectory()) return { ok: false, path, branch: null, reason: "not a folder" };
  } catch {
    return { ok: false, path, branch: null, reason: "no such folder" };
  }
  return { ok: true, path, branch: gitBranch(path) };
}

/** HEAD's branch by reading .git directly (no git spawn). Follows a plain .git file for worktrees. */
export function gitBranch(path: string): string | null {
  let dir = path;
  for (let i = 0; i < 12; i++) {
    const g = join(dir, ".git");
    if (existsSync(g)) {
      try {
        let gitDir = g;
        if (statSync(g).isFile()) {
          const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(g, "utf8"));
          if (!m) return null;
          gitDir = resolve(dir, m[1].trim());
        }
        const headRef = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(headRef);
        return ref ? ref[1] : headRef.slice(0, 7);
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** The native folder chooser (macOS). Resolves null when cancelled or unavailable. */
export function pickFolder(defaultPath?: string): Promise<string | null> {
  if (process.platform !== "darwin") return Promise.resolve(null);
  const start = defaultPath && existsSync(defaultPath) ? ` default location (POSIX file ${JSON.stringify(defaultPath)})` : "";
  const script = `POSIX path of (choose folder with prompt "Folder for the new desk"${start})`;
  return new Promise((resolveP) => {
    execFile("/usr/bin/osascript", ["-e", script], { timeout: 120_000 }, (err, stdout) => {
      if (err) return resolveP(null); // cancelled (osascript exits 1) or no UI session
      const out = String(stdout).trim().replace(/\/$/, "");
      resolveP(out || null);
    });
  });
}
