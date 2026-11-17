import { Listeners } from "../core/listeners.ts";
import { keyedQueue } from "../core/serial.ts";

const settled = new Listeners<[root: string]>();
const repos = keyedQueue((root) => settled.emit(root));

export function serial<T>(root: string, work: () => Promise<T>): Promise<T> {
  return repos(root, work);
}

export function onRepoSettled(listener: (root: string) => void): () => void {
  return settled.add(listener);
}
