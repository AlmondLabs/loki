import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { serial } from "./repo-queue.ts";

/**
 * An agent's memory kept the same on every paired Mac (plan 023, U7, KTD7, R15, R16). Memory is a git repo, so it
 * travels as git does: a Mac asks another for the commits it lacks, which come as a bundle, and merges them inside the
 * repo's queue. Git merges edits to different notes, and to different parts of one note, on its own. When two Macs
 * changed the same lines, the note keeps the text of the agent's home Mac and the other text goes to one conflicts
 * note (CONFLICTS_PATH), which the agent's next reflection reads and reconciles: a note never holds conflict markers,
 * and nothing is silently lost.
 */

const run = promisify(execFile);
const git = (root: string, ...args: string[]) =>
  run("git", ["-C", root, "-c", "core.hooksPath=/dev/null", "-c", "core.autocrlf=false", ...args], { maxBuffer: 64 * 1024 * 1024 });

/** Where the other side of a clash is kept for reflection, relative to the memory root. */
export const CONFLICTS_PATH = "conflicts/sync.md";
/** Who a merge's commit is by, as the Agents page shows it. */
const SYNC = { name: "Sync", email: "sync@loki.local" };

/** The repo's current commit, or null when there is no repo or no commit yet. */
export async function memoryHead(root: string): Promise<string | null> {
  if (!existsSync(join(root, ".git"))) return null;
  try {
    return (await git(root, "rev-parse", "HEAD")).stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * The commits another Mac lacks, as a base64 git bundle: everything reachable from HEAD but not from the commits it
 * says it has (those this repo does not know are left out of the sum). Null when there is nothing it lacks, or no repo.
 */
export async function memoryBundle(root: string, have: string[]): Promise<string | null> {
  const head = await memoryHead(root);
  if (!head) return null;
  const known: string[] = [];
  for (const sha of have) {
    if (!/^[0-9a-f]{40}$/.test(sha)) continue;
    try {
      await git(root, "cat-file", "-e", `${sha}^{commit}`);
      known.push(sha);
    } catch {
      // a commit only the asking Mac has
    }
  }
  if (known.includes(head)) return null;
  const dir = mkdtempSync(join(tmpdir(), "loki-bundle-"));
  try {
    const file = join(dir, "memory.bundle");
    await serial(root, () => git(root, "bundle", "create", "--quiet", file, "HEAD", ...known.map((k) => `^${k}`)));
    return readFileSync(file).toString("base64");
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** What taking another Mac's memory did here. */
export type MemoryApplied = "cloned" | "merged" | "conflicted" | "unchanged";

/**
 * Take another Mac's commits for an agent's memory: clone them when this Mac has no repo yet, else merge them. On a
 * clash each clashing note keeps the home Mac's text (`homeIsHere` says whether that is this Mac's side) and the
 * other text is added to the conflicts note, all in one merge commit by "Sync".
 */
export function applyMemoryBundle(root: string, bundle: string, opts: { from: string; homeIsHere: boolean; now?: () => Date }): Promise<MemoryApplied> {
  return serial(root, async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-bundle-"));
    const file = join(dir, "memory.bundle");
    writeFileSync(file, Buffer.from(bundle, "base64"));
    try {
      if (!existsSync(join(root, ".git"))) {
        mkdirSync(dirname(root), { recursive: true });
        rmSync(root, { recursive: true, force: true });
        await run("git", ["clone", "--quiet", file, root]);
        await git(root, "remote", "remove", "origin").catch(() => undefined);
        return "cloned";
      }
      const before = await memoryHead(root);
      await git(root, "fetch", "--quiet", file, `HEAD:refs/peers/${opts.from}`, "--force");
      const theirs = (await git(root, "rev-parse", `refs/peers/${opts.from}`)).stdout.trim();
      try {
        await git(root, "-c", `user.name=${SYNC.name}`, "-c", `user.email=${SYNC.email}`, "merge", "--quiet", "--no-edit", theirs);
        return (await memoryHead(root)) === before ? "unchanged" : "merged";
      } catch {
        await settleClash(root, opts);
        return "conflicted";
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

/** Finish a merge that clashed: the home Mac's text in each note, the other side in the conflicts note, one commit. */
async function settleClash(root: string, opts: { from: string; homeIsHere: boolean; now?: () => Date }): Promise<void> {
  const unmerged = (await git(root, "diff", "--name-only", "--diff-filter=U")).stdout.split("\n").filter(Boolean);
  const stage = async (n: 2 | 3, path: string): Promise<string | null> => {
    try {
      return (await git(root, "show", `:${n}:${path}`)).stdout;
    } catch {
      return null; // that side deleted it
    }
  };
  const at = (opts.now?.() ?? new Date()).toISOString();
  const notes: string[] = [];
  for (const path of unmerged) {
    const ours = await stage(2, path);
    const theirs = await stage(3, path);
    const [kept, other, otherMac] = opts.homeIsHere ? [ours, theirs, opts.from] : [theirs, ours, "this Mac"];
    if (kept === null) await git(root, "rm", "--quiet", "--force", "--", path);
    else {
      writeFileSync(join(root, path), kept);
      await git(root, "add", "--", path);
    }
    if (other !== null && other !== kept)
      notes.push(`## ${path}\n\nFrom ${otherMac}, ${at}. The note kept the home Mac's text; this was the other:\n\n${other.trimEnd()}\n`);
  }
  if (notes.length) {
    const file = join(root, CONFLICTS_PATH);
    mkdirSync(dirname(file), { recursive: true });
    const before = existsSync(file) ? readFileSync(file, "utf8") : "# Clashes between Macs\n\nReconcile each into its note, then delete it from here.\n";
    writeFileSync(file, `${before.trimEnd()}\n\n${notes.join("\n")}`);
    await git(root, "add", "--", CONFLICTS_PATH);
  }
  await git(root, "-c", `user.name=${SYNC.name}`, "-c", `user.email=${SYNC.email}`, "commit", "--quiet", "--no-edit");
}

/** The clashes waiting for reflection in an agent's memory, or null when there are none. */
export function pendingConflicts(root: string): string | null {
  try {
    const text = readFileSync(join(root, CONFLICTS_PATH), "utf8");
    return /^## /m.test(text) ? text : null;
  } catch {
    return null;
  }
}
