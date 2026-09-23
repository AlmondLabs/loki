/**
 * Bounded recent histories on the device — searches, places opened — in localStorage, sanitized on
 * read so a stale or tampered entry drops instead of becoming a broken row. Each caller names its own
 * storage key (the phone's are loki.phone.*). Pure enough for Bun (test/phone-session.test.ts).
 */

/** One remembered thing: a search's text or a destination's hash, and when. */
export type RecentEntry = { v: string; at: number };
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** A new entry first; a repeat moves up rather than doubling; blank is nothing; at most `max`. */
export function pushRecent(list: RecentEntry[], value: string, at: number, max: number): RecentEntry[] {
  const v = value.trim();
  if (!v) return list;
  return [{ v, at }, ...list.filter((e) => e.v !== v)].slice(0, max);
}

/**
 * Stored text back to entries, trusting none of it: junk and wrong shapes drop, so do entries older
 * than `maxAgeMs`, duplicates, and anything `valid` no longer recognises (a desk since deleted, an
 * agent gone) — a stale entry disappears instead of becoming a broken row.
 */
export function sanitizeRecents(raw: string | null, { max, maxAgeMs, now, valid }: { max: number; maxAgeMs: number; now: number; valid?: (v: string) => boolean }): RecentEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const out: RecentEntry[] = [];
  for (const e of parsed) {
    if (!e || typeof e !== "object") continue;
    const { v, at } = e as Record<string, unknown>;
    if (typeof v !== "string" || !v.trim() || typeof at !== "number" || !Number.isFinite(at)) continue;
    if (now - at > maxAgeMs || seen.has(v) || (valid && !valid(v))) continue;
    seen.add(v);
    out.push({ v, at });
    if (out.length >= max) break;
  }
  return out;
}

/** localStorage when the page may use it; a private window or a blocked site reads as none. */
function safeStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

const DAY = 86_400_000;

/** One bounded history under one storage key. Every storage call is guarded: a failure is an empty list, never a throw. */
export function createRecents({ storage = safeStorage(), key, max, maxAgeMs = 30 * DAY, now = Date.now }: { storage?: StorageLike | null; key: string; max: number; maxAgeMs?: number; now?: () => number }) {
  const load = (valid?: (v: string) => boolean): RecentEntry[] => {
    try {
      return sanitizeRecents(storage?.getItem(key) ?? null, { max, maxAgeMs, now: now(), valid });
    } catch {
      return [];
    }
  };
  return {
    /** Newest first, values only, filtered by what the caller can still open. */
    read: (valid?: (v: string) => boolean): string[] => load(valid).map((e) => e.v),
    add(value: string) {
      try {
        storage?.setItem(key, JSON.stringify(pushRecent(load(), value, now(), max)));
      } catch {
        /* full or blocked: the history is a convenience */
      }
    },
    /** One entry out (a recent search's ×). */
    remove(value: string) {
      try {
        const kept = load().filter((e) => e.v !== value);
        if (kept.length) storage?.setItem(key, JSON.stringify(kept));
        else storage?.removeItem(key);
      } catch {
        /* as above */
      }
    },
    clear() {
      try {
        storage?.removeItem(key);
      } catch {
        /* as above */
      }
    },
  };
}

export type Recents = ReturnType<typeof createRecents>;
