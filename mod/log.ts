import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { messageOf } from "../core/errors.ts";

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

export function log(event: string, detail?: unknown): void {
  if (!target) return;
  try {
    if (++sinceCheck >= LOG_CHECK_EVERY) {
      sinceCheck = 0;
      rotateIfLarge(target);
    }
    const line = detail === undefined ? event : `${event} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
    appendFileSync(target, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}
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
