import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The files loki keeps under ~/.loki, read and written one way: read forgivingly, since a person or a crash may leave
 * anything there, and written beside the file and renamed over it, so a crash leaves the old file or the new one, never
 * half of one.
 */

/** How writeFileAtomic writes a file. */
export interface AtomicWriteOptions {
  /** The new file's mode, as 0o600 for a file that holds tokens or pairings; the process's default when left out. */
  mode?: number;
  /** Name the file written first after this process too, for a file two processes may write at once. */
  pidTemp?: boolean;
}

/** How writeJsonAtomic lays out the JSON, on top of how the file is written. */
export interface JsonWriteOptions extends AtomicWriteOptions {
  /** Indented two spaces, for a file a person may open; one line when left out. */
  pretty?: boolean;
  /** Ended with a newline. */
  newline?: boolean;
}

/** A JSON file's contents, or null when it is missing or not JSON; the caller says what it holds. */
export function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** Write a file whole, its folder made first: beside it, then renamed into place. Throws what the file system throws. */
export function writeFileAtomic(file: string, data: string | Uint8Array, opts: AtomicWriteOptions = {}): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = opts.pidTemp ? `${file}.${String(process.pid)}.tmp` : `${file}.tmp`;
  writeFileSync(temp, data, opts.mode === undefined ? undefined : { mode: opts.mode });
  renameSync(temp, file);
}

/** Write a value as JSON with writeFileAtomic. */
export function writeJsonAtomic(file: string, value: unknown, opts: JsonWriteOptions = {}): void {
  writeFileAtomic(file, JSON.stringify(value, null, opts.pretty ? 2 : undefined) + (opts.newline ? "\n" : ""), opts);
}
