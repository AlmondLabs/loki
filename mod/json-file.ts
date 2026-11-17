import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface AtomicWriteOptions {
  mode?: number;
  pidTemp?: boolean;
}

export interface JsonWriteOptions extends AtomicWriteOptions {
  pretty?: boolean;
  newline?: boolean;
}

export function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

export function writeFileAtomic(file: string, data: string | Uint8Array, opts: AtomicWriteOptions = {}): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = opts.pidTemp ? `${file}.${String(process.pid)}.tmp` : `${file}.tmp`;
  writeFileSync(temp, data, opts.mode === undefined ? undefined : { mode: opts.mode });
  renameSync(temp, file);
}

export function writeJsonAtomic(file: string, value: unknown, opts: JsonWriteOptions = {}): void {
  writeFileAtomic(file, JSON.stringify(value, null, opts.pretty ? 2 : undefined) + (opts.newline ? "\n" : ""), opts);
}
