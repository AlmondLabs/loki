import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";
import type { FolderCheck } from "../core/frame-types.ts";

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
  const script = `POSIX path of (choose folder with prompt "Folder for the new chat"${start})`;
  return new Promise((resolveP) => {
    execFile("/usr/bin/osascript", ["-e", script], { timeout: 120_000 }, (err, stdout) => {
      if (err) return resolveP(null); // cancelled (osascript exits 1) or no UI session
      const out = String(stdout).trim().replace(/\/$/, "");
      resolveP(out || null);
    });
  });
}
