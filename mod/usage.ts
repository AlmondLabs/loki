import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { USAGE_ACTION_RE, usageLine, type UsageSurface } from "../core/usage.ts";
import { rotateIfLarge } from "./log.ts";

/**
 * The usage log's writer (core/usage.ts has the shape): one JSON line per action, appended to
 * ~/.letta/loki/logs/usage.jsonl. Past USAGE_MAX_BYTES the file becomes usage.jsonl.1 and a fresh one
 * starts, so the pair keeps about two years at a few hundred lines a day. Never throws; a null path
 * (LOKI_USAGE_LOG=0) records nothing.
 */
export const USAGE_MAX_BYTES = 20 * 1024 * 1024;
export const USAGE_CHECK_EVERY = 100;

export interface UsageLog {
  path: string | null;
  /** Append one line; false when refused (no path, or an action name that is not a plain lowercase word). */
  record(surface: UsageSurface, action: string, detail?: Record<string, unknown>): boolean;
}

export function createUsageLog(path: string | null, opts: { maxBytes?: number; checkEvery?: number; now?: () => Date } = {}): UsageLog {
  const max = opts.maxBytes ?? USAGE_MAX_BYTES;
  const every = opts.checkEvery ?? USAGE_CHECK_EVERY;
  let sinceCheck = 0;
  let ready = false;
  return {
    path,
    record(surface, action, detail) {
      if (!path || !USAGE_ACTION_RE.test(action)) return false;
      try {
        if (!ready) {
          mkdirSync(dirname(path), { recursive: true });
          ready = true;
        }
        if (++sinceCheck >= every) {
          sinceCheck = 0;
          rotateIfLarge(path, max);
        }
        appendFileSync(path, `${JSON.stringify(usageLine(surface, action, detail, opts.now?.()))}\n`);
        return true;
      } catch {
        return false; // the log must never affect the desk
      }
    },
  };
}
