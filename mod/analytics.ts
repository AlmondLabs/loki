import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EVENT_NAME_RE, EVENT_NAME_MAX, SESSION_GAP_MS, makeEvent, type DeviceType, type EventProperties } from "../core/analytics.ts";
import { rotateIfLarge } from "./log.ts";

/**
 * The analytics writer (core/analytics.ts has the shape): capture() appends one event to
 * ~/.letta/loki/logs/events.jsonl with the system properties filled in — the device, a session cut on a
 * 30-minute gap per device, the app version, and one distinct_id minted per install and kept in
 * state/analytics.json. Past EVENTS_MAX_BYTES the file becomes events.jsonl.1 and a fresh one starts,
 * about two years at a few hundred events a day. Never throws; a null path (LOKI_ANALYTICS=0) captures nothing.
 */
export const EVENTS_MAX_BYTES = 20 * 1024 * 1024;
export const EVENTS_CHECK_EVERY = 100;

export interface Analytics {
  path: string | null;
  distinctId: string;
  /** Append one event; false when refused (no path, or an event name that is not snake_case). */
  capture(device: DeviceType, event: string, properties?: Record<string, unknown>): boolean;
}

export function createAnalytics(opts: { path: string | null; statePath: string; appVersion?: string | null; maxBytes?: number; checkEvery?: number; sessionGapMs?: number; now?: () => Date }): Analytics {
  const { path, statePath } = opts;
  const max = opts.maxBytes ?? EVENTS_MAX_BYTES;
  const every = opts.checkEvery ?? EVENTS_CHECK_EVERY;
  const gap = opts.sessionGapMs ?? SESSION_GAP_MS;
  const now = opts.now ?? (() => new Date());
  const distinctId = readOrMintId(statePath);
  const sessions = new Map<DeviceType, { id: string; last: number }>();
  let sinceCheck = 0;
  let ready = false;
  return {
    path,
    distinctId,
    capture(device, event, properties) {
      if (!path || event.length > EVENT_NAME_MAX || !EVENT_NAME_RE.test(event)) return false;
      try {
        const at = now();
        const t = at.getTime();
        let session = sessions.get(device);
        if (!session || t - session.last > gap) session = { id: randomUUID(), last: t };
        session.last = t;
        sessions.set(device, session);
        // A client may bring its own properties ($screen among them); the system's win where they overlap.
        const props: EventProperties = { ...properties, $device_type: device, $session_id: session.id, $app_version: opts.appVersion ?? null, $lib: "loki" };
        if (!ready) {
          mkdirSync(dirname(path), { recursive: true });
          ready = true;
        }
        if (++sinceCheck >= every) {
          sinceCheck = 0;
          rotateIfLarge(path, max);
        }
        appendFileSync(path, `${JSON.stringify(makeEvent(event, distinctId, props, at))}\n`);
        return true;
      } catch {
        return false; // analytics must never affect the desk
      }
    },
  };
}

/** The install's id from state/analytics.json, minted on first use. A file that cannot be written leaves an id for this run only. */
function readOrMintId(statePath: string): string {
  try {
    const v = JSON.parse(readFileSync(statePath, "utf8")) as { distinct_id?: unknown };
    if (typeof v.distinct_id === "string" && v.distinct_id) return v.distinct_id;
  } catch {
    // no file yet
  }
  const id = randomUUID();
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, `${JSON.stringify({ distinct_id: id })}\n`);
  } catch {
    // keep the id for this run
  }
  return id;
}

/** loki's version: stamped into the bundle by scripts/build-mod.ts, or read from a checkout's package.json. */
export function appVersion(root: string): string | null {
  if (process.env.LOKI_VERSION) return process.env.LOKI_VERSION;
  try {
    const v = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown }).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}
