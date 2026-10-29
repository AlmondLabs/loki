import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { messageOf } from "../core/errors.ts";

/**
 * Append-only trace log at ~/.loki/mod.log. The mod runs inside loki's daemon,
 * whose own output goes to ~/.loki/logs/daemon.log; this file is the mod's trace
 * of activation, tool calls, scans, and errors on its own. Never throws.
 *
 * Rotation: past LOG_MAX_BYTES the file is renamed to mod.log.1 (replacing the
 * previous one) and a fresh mod.log starts, so the pair never passes ~10 MB.
 * The size is checked every LOG_CHECK_EVERY lines, not on each append.
 */
let target: string | null = null;
let sinceCheck = 0;

/** The size, in bytes, past which mod.log is rotated to mod.log.1. */
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
/** How many lines pass between checks of the log's size. */
export const LOG_CHECK_EVERY = 200;

/** Points the trace log at `path`, creating its folder; when the folder cannot be made, logging stays off. */
export function initLog(path: string): void {
  target = path;
  sinceCheck = 0;
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    target = null;
  }
}

/** Rename `path` to `path.1` when it has grown past `max`; true when it did. Exported for the test. */
export function rotateIfLarge(path: string, max = LOG_MAX_BYTES): boolean {
  try {
    if (statSync(path).size <= max) return false;
    renameSync(path, `${path}.1`);
    return true;
  } catch {
    return false; // no file yet, or a rename we cannot do: keep appending
  }
}

/** One line in the trace log: a timestamp, the event, and the detail as a string or JSON. Does nothing before initLog. */
export function log(event: string, detail?: unknown): void {
  if (!target) return;
  try {
    if (++sinceCheck >= LOG_CHECK_EVERY) {
      sinceCheck = 0;
      rotateIfLarge(target);
    }
    const line = detail === undefined ? event : `${event} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
    appendFileSync(target, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // logging must never affect the desk
  }
}
/** Resolve with `fallback` if `p` takes longer than `ms`; logs the timeout. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => {
      log("timeout", { label, ms });
      resolve(fallback);
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(t);
        log("error", { label, error: messageOf(err) });
        resolve(fallback);
      },
    );
  });
}
