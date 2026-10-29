import { Listeners } from "../core/listeners.ts";
import { keyedQueue } from "../core/serial.ts";

/**
 * One git command sequence at a time per memory repo. A chat's memory_write, a reflection pass, an edit from the
 * Agents page, a skill refresh and a merge from a paired Mac (plan 023) can land together; two `git add`/`commit`s at
 * once in one repo fail on its index.lock, and the write that lost was on disk but never committed. Kept apart from
 * daemon/memory.ts so the mod's own git users take the same queue without bundling the memory tools.
 */
const settled = new Listeners<[root: string]>();
const repos = keyedQueue((root) => settled.emit(root));

/** Run `work` on the repo at `root` once every earlier sequence there has settled, failed or not; settles as `work` does. */
export function serial<T>(root: string, work: () => Promise<T>): Promise<T> {
  return repos(root, work);
}

/** Hear when a sequence on a repo has settled, which may have committed: a paired Mac is then told (plan 023, U7). Returns the unsubscribe. */
export function onRepoSettled(listener: (root: string) => void): () => void {
  return settled.add(listener);
}
