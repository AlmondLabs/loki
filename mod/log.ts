import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Append-only trace log at ~/.letta/loci/mod.log. The mod runs inside a Letta
 * process with no console we can read, so this is how we see activation, tool
 * calls, scans, and errors. Never throws.
 */
let target: string | null = null;

export function initLog(path: string): void {
  target = path;
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    target = null;
  }
}

export function log(event: string, detail?: unknown): void {
  if (!target) return;
  try {
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
      (err) => {
        clearTimeout(t);
        log("error", { label, error: err instanceof Error ? err.message : String(err) });
        resolve(fallback);
      },
    );
  });
}
