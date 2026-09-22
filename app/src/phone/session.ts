import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import type { ImageAttachment } from "../../../core/attention/content.ts";

/**
 * The phone's session: what a person was in the middle of, kept across tabs and pages so navigation
 * never costs them their place. Four small stores, one mechanism each, no domain data:
 *   drafts   a reply's text and images, keyed by agent and conversation (memory; Inbox and the desk share it)
 *   recents  recent searches and destinations, bounded, on the device (localStorage, sanitized on read)
 *   scroll   each destination's list offset (memory)
 *   focus    the control a page was opened from, handed back when you return (memory)
 * The factories are pure enough for Bun (test/phone-session.test.ts); the hooks wire them to React.
 */

// ---- Drafts ---------------------------------------------------------------------------------------

export type Draft = { text: string; images: ImageAttachment[] };
export const EMPTY_DRAFT: Draft = Object.freeze({ text: "", images: [] }) as Draft;

/** One conversation's key: the same one for its Inbox card and its desk page. */
export const draftKey = (agentId: string, conversationId: string): string => `${agentId}\u0000${conversationId}`;

export function createDrafts() {
  const store = new Map<string, Draft>();
  const subs = new Map<string, Set<() => void>>();
  const emit = (key: string) => subs.get(key)?.forEach((fn) => fn());
  return {
    /** The draft, or the one shared empty draft; the same object until it changes. */
    get: (key: string): Draft => store.get(key) ?? EMPTY_DRAFT,
    set(key: string, d: Draft) {
      if (!d.text && d.images.length === 0) {
        if (!store.delete(key)) return;
      } else store.set(key, d);
      emit(key);
    },
    /** After a send: only the submitted conversation's draft goes. */
    clear(key: string) {
      if (store.delete(key)) emit(key);
    },
    keys: (): string[] => [...store.keys()],
    subscribe(key: string, fn: () => void): () => void {
      let set = subs.get(key);
      if (!set) subs.set(key, (set = new Set()));
      set.add(fn);
      return () => void set.delete(fn);
    },
  };
}
export type Drafts = ReturnType<typeof createDrafts>;

/** The phone's drafts, for the page's lifetime: tab changes, pages, disconnects and theme changes leave them alone. */
export const drafts = createDrafts();

/**
 * A conversation's draft as React state: `[draft, setDraft, clearDraft]`. A null key (nothing open) is
 * the empty draft and ignores writes. Every screen showing the same conversation sees the same text.
 */
export function useDraft(key: string | null, store: Drafts = drafts): [Draft, (d: Draft) => void, () => void] {
  const draft = useSyncExternalStore(
    useCallback((fn: () => void) => (key ? store.subscribe(key, fn) : () => {}), [key, store]),
    () => (key ? store.get(key) : EMPTY_DRAFT),
  );
  const set = useCallback((d: Draft) => key && store.set(key, d), [key, store]);
  const clear = useCallback(() => key && store.clear(key), [key, store]);
  return [draft, set, clear];
}

// ---- Recents --------------------------------------------------------------------------------------

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

/** What Search offers before you type: the last few searches, and the last few places opened (as route hashes). */
export const recentSearches = createRecents({ key: "loki.phone.recentSearches", max: 8 });
export const recentPlaces = createRecents({ key: "loki.phone.recentPlaces", max: 8 });

// ---- Scroll ---------------------------------------------------------------------------------------

export function createScrollMemory() {
  const offsets = new Map<string, number>();
  return {
    save: (key: string, top: number) => void offsets.set(key, Math.max(0, Math.round(top))),
    get: (key: string): number | null => offsets.get(key) ?? null,
  };
}
export const scrollMemory = createScrollMemory();

/**
 * Keeps a scroll owner's offset under `key`: saved as it scrolls, put back when it mounts and whenever
 * it comes back into view (a hidden tab's list has no box, and browsers drop its offset). Offsets read
 * while the element has no height are not saved, so hiding never overwrites the real one.
 */
export function useScrollMemory(ref: RefObject<HTMLElement | null>, key: string | undefined, memory = scrollMemory) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !key) return;
    const restore = () => {
      const top = memory.get(key);
      if (top !== null && el.clientHeight > 0) el.scrollTop = top;
    };
    restore();
    const onScroll = () => {
      if (el.clientHeight > 0) memory.save(key, el.scrollTop);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    let shown = el.clientHeight > 0;
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      const now = el.clientHeight > 0;
      if (now && !shown) restore();
      shown = now;
    });
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro?.disconnect();
    };
  }, [ref, key, memory]);
}

// ---- Focus ----------------------------------------------------------------------------------------

/**
 * The control each destination was left from, by route hash. A remounted screen has new elements, so
 * an `id` or `data-launch` attribute is kept too and looked up again when the element itself is gone.
 */
export function createFocusMemory() {
  const launchers = new Map<string, { el: Element; id: string | null; launch: string | null }>();
  return {
    remember(hash: string, el: Element | null) {
      if (!el) return;
      launchers.set(hash, { el, id: el.id || null, launch: el.getAttribute("data-launch") });
    },
    take(hash: string): Element | null {
      const hit = launchers.get(hash);
      launchers.delete(hash);
      if (!hit) return null;
      if (hit.el.isConnected) return hit.el;
      if (typeof document === "undefined") return null;
      if (hit.id) return document.getElementById(hit.id);
      if (hit.launch) return document.querySelector(`[data-launch="${CSS.escape(hit.launch)}"]`);
      return null;
    },
  };
}
export const focusMemory = createFocusMemory();

/** The element that has focus now, when it is a real control (iOS leaves focus on the body after a tap). */
export function activeControl(): Element | null {
  if (typeof document === "undefined") return null;
  const a = document.activeElement;
  return a && a !== document.body && a !== document.documentElement ? a : null;
}

const visible = (el: Element) => el.getClientRects().length > 0;

/**
 * After a route change: back at a destination, focus the control it was left from; arriving anywhere
 * else (or when that control is gone), the visible screen's heading. `root` bounds the search.
 */
export function restoreFocus(root: Element, hash: string, returning: boolean, memory = focusMemory) {
  // A screen that put focus in its own field (Search's autofocus) keeps it: the keyboard is already up.
  const active = activeControl();
  if (!returning && active && root.contains(active) && active.matches("input, textarea") && visible(active)) return;
  const launcher = returning ? memory.take(hash) : null;
  if (launcher instanceof HTMLElement && visible(launcher)) {
    launcher.focus({ preventScroll: true });
    return;
  }
  const heading = [...root.querySelectorAll<HTMLElement>("[data-phone-heading]")].find(visible);
  heading?.focus({ preventScroll: true });
}

/** Runs restoreFocus when `routeKey` changes, after the new screen has rendered; not on first load. */
export function useFocusOnRoute(root: RefObject<HTMLElement | null>, routeKey: string, returning: boolean) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (root.current) restoreFocus(root.current, routeKey, returning);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey]);
}
