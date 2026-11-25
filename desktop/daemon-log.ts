import { mkdirSync, openSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";

export const LOG_MAX_BYTES = 10 * 1024 * 1024;

export function rotateLog(log: string, max: number, warn: (line: string) => void = () => {}): void {
  let size: number;
  try {
    size = statSync(log).size;
  } catch {
    return;
  }
  if (size <= max) return;
  const aside = `${log}.1`;
  rmSync(aside, { force: true });
  try {
    renameSync(log, aside);
  } catch (error) {
    warn(`could not set the daemon's log aside: ${String(error)}`);
  }
}

export function openDaemonLog(log: string, opts: { max?: number; warn?: (line: string) => void } = {}): number {
  mkdirSync(dirname(log), { recursive: true });
  rotateLog(log, opts.max ?? LOG_MAX_BYTES, opts.warn);
  return openSync(log, "a");
}
