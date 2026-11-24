import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { messageOf } from "../core/errors.ts";
import { logLine, type Severity } from "../core/log-line.ts";

let target: string | null = null;
let sinceCheck = 0;

export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_CHECK_EVERY = 200;

export function initLog(path: string): void {
  target = path;
  sinceCheck = 0;
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    target = null;
  }
}

export function rotateIfLarge(path: string, max = LOG_MAX_BYTES): boolean {
  try {
    if (statSync(path).size <= max) return false;
    renameSync(path, `${path}.1`);
    return true;
  } catch {
    return false;
  }
}

function write(severity: Severity, event: string, detail?: unknown): void {
  if (!target) return;
  try {
    if (++sinceCheck >= LOG_CHECK_EVERY) {
      sinceCheck = 0;
      rotateIfLarge(target);
    }
    const line = detail === undefined ? event : `${event} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
    appendFileSync(target, `${logLine(new Date(), severity, line)}\n`);
  } catch {}
}

type Log = (event: string, detail?: unknown) => void;

export const log: Log & { warning: Log; error: Log } = Object.assign((event: string, detail?: unknown) => write("info", event, detail), {
  warning: (event: string, detail?: unknown) => write("warning", event, detail),
  error: (event: string, detail?: unknown) => write("error", event, detail),
});

export function withTimeout<T>(p: Promise<T>, ms: number, label: string, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => {
      log.warning("timeout", { label, ms });
      resolve(fallback);
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(t);
        log.error("error", { label, error: messageOf(err) });
        resolve(fallback);
      },
    );
  });
}
