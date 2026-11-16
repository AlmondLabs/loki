import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { onRepoSettled, serial } from "./repo-queue.ts";

const run = promisify(execFile);
// Git tidies a repo after a fetch, merge or commit in a process of its own that outlives the call; kept in the call
const git = (root: string, ...args: string[]) =>
  run(
    "git",
    ["-C", root, "-c", "core.hooksPath=/dev/null", "-c", "core.autocrlf=false", "-c", "maintenance.autoDetach=false", "-c", "gc.autoDetach=false", ...args],
    {
      maxBuffer: 64 * 1024 * 1024,
    },
  );

export const CONFLICTS_PATH = "conflicts/sync.md";
const SYNC = { name: "Sync", email: "sync@loki.local" };

export async function memoryHead(root: string): Promise<string | null> {
  if (!existsSync(join(root, ".git"))) return null;
  try {
    return (await git(root, "rev-parse", "HEAD")).stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function memoryBundle(root: string, have: string[]): Promise<string | null> {
  const head = await memoryHead(root);
  if (!head) return null;
  const known: string[] = [];
  for (const sha of have) {
    if (!/^[0-9a-f]{40}$/.test(sha)) continue;
    try {
      await git(root, "cat-file", "-e", `${sha}^{commit}`);
      known.push(sha);
    } catch {}
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

export type MemoryApplied = "cloned" | "merged" | "conflicted" | "unchanged";

export function applyMemoryBundle(root: string, bundle: string, opts: { from: string; homeIsHere: boolean; now?: () => Date }): Promise<MemoryApplied> {
  return serial(root, async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-bundle-"));
    const file = join(dir, "memory.bundle");
    writeFileSync(file, Buffer.from(bundle, "base64"));
    try {
      if (!existsSync(join(root, ".git"))) {
        mkdirSync(dirname(root), { recursive: true });
        rmSync(root, { recursive: true, force: true });
        // Kept in the clone's own config: Windows' git checks notes out with CRLF otherwise, unlike the home Mac's.
        await run("git", ["clone", "--quiet", "--config", "core.autocrlf=false", file, root]);
        await git(root, "remote", "remove", "origin").catch(() => undefined);
        return "cloned";
      }
      const before = await memoryHead(root);
      await git(root, "fetch", "--quiet", file, `HEAD:refs/peers/${opts.from}`, "--force");
      const theirs = (await git(root, "rev-parse", `refs/peers/${opts.from}`)).stdout.trim();
      try {
        await git(root, "-c", `user.name=${SYNC.name}`, "-c", `user.email=${SYNC.email}`, "merge", "--quiet", "--no-edit", theirs);
        return (await memoryHead(root)) === before ? "unchanged" : "merged";
      } catch (error) {
        // Only a merge git stopped part way (MERGE_HEAD set) is a clash to settle; one that never began (a file in the
        const merging = await git(root, "rev-parse", "-q", "--verify", "MERGE_HEAD").then(
          () => true,
          () => false,
        );
        if (!merging) throw error;
        await settleClash(root, opts);
        return "conflicted";
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

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

export const memoryRepos = {
  serial,
  onSettled: onRepoSettled,
  head: memoryHead,
  bundle: memoryBundle,
  apply: applyMemoryBundle,
};

export type MemoryRepos = typeof memoryRepos;

export function pendingConflicts(root: string): string | null {
  try {
    const text = readFileSync(join(root, CONFLICTS_PATH), "utf8");
    return /^## /m.test(text) ? text : null;
  } catch {
    return null;
  }
}
