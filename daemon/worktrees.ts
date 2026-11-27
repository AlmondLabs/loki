import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { messageOf } from "../core/errors.ts";

const execFileAsync = promisify(execFile);

const NO_FILE = process.platform === "win32" ? "NUL" : "/dev/null";
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: NO_FILE,
  GIT_TERMINAL_PROMPT: "0",
};
const GIT_FLAGS = ["-c", `core.hooksPath=${NO_FILE}`, "-c", "core.fsmonitor=false"];
const VALID_ID = /^[a-z0-9][a-z0-9_-]*$/i;

export interface WorktreeInfo {
  readonly repoRoot: string;
  readonly path: string;
  readonly branch: string;
  readonly cwd: string;
}

export interface WorktreeOps {
  create(repoCwd: string, id: string): Promise<WorktreeInfo>;
  remove(info: WorktreeInfo): Promise<void>;
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...GIT_FLAGS, ...args], {
    cwd,
    env: GIT_ENV,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

export async function createWorktree(repoCwd: string, worktreesDir: string, id: string): Promise<WorktreeInfo> {
  if (!VALID_ID.test(id)) throw new Error(`invalid worktree id: ${id}`);
  let repoRoot: string;
  try {
    repoRoot = await runGit(repoCwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    throw new Error("workspace: 'worktree' requires a git repository.");
  }
  const [realRoot, realCwd] = await Promise.all([realpath(repoRoot), realpath(repoCwd)]);
  const rel = relative(realRoot, realCwd);
  await mkdir(worktreesDir, { recursive: true });
  const worktreePath = join(worktreesDir, id);
  const branch = `loki-subagent/${id}`;
  try {
    await runGit(repoRoot, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
  } catch (error) {
    await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
    throw new Error(`could not create git worktree: ${messageOf(error)}`);
  }
  const subCwd = rel && !rel.startsWith("..") && !isAbsolute(rel) ? join(worktreePath, rel) : worktreePath;
  const cwd = existsSync(subCwd) ? subCwd : worktreePath;
  return { repoRoot, path: worktreePath, branch, cwd };
}

export async function removeWorktree(info: WorktreeInfo): Promise<void> {
  await runGit(info.repoRoot, ["worktree", "remove", "--force", info.path]).catch(() => {});
  await rm(info.path, { recursive: true, force: true }).catch(() => {});
  await runGit(info.repoRoot, ["worktree", "prune"]).catch(() => {});
  // Lowercase -d removes the branch only if merged / without unmerged commits, so helper work is never silently lost.
  await runGit(info.repoRoot, ["branch", "-d", info.branch]).catch(() => {});
}

export function defaultWorktreeOps(worktreesDir: string): WorktreeOps {
  return {
    create: (repoCwd, id) => createWorktree(repoCwd, worktreesDir, id),
    remove: (info) => removeWorktree(info),
  };
}
