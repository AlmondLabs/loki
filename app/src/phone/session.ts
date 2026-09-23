import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { draftKey } from "../shared/drafts";
import { createRecents } from "../shared/recents";

/**
 * The phone's session: what a person was in the middle of, kept across tabs and pages so navigation
 * never costs them their place. Four small stores, one mechanism each, no domain data:
 *   drafts   a reply's text and images, keyed by agent and conversation (memory; Inbox and the desk share it; shared/drafts.ts)
 *   recents  recent searches and destinations, bounded, on the device (localStorage, sanitized on read; shared/recents.ts)
 *   scroll   each destination's list offset (memory)
 *   focus    the control a page was opened from, handed back when you return (memory)
 * The factories are pure enough for Bun (test/phone-session.test.ts); the hooks wire them to React.
 */

// ---- Drafts ---------------------------------------------------------------------------------------

// Shared with the desktop (shared/drafts.ts): one store, one mechanism; the phone keeps its names.
export { EMPTY_DRAFT, createDrafts, draftKey, drafts, useDraft, type Draft, type Drafts } from "../shared/drafts";

// ---- Prefill --------------------------------------------------------------------------------------

/** A `?prefill=` held for the one conversation it was addressed to. */
export type Prefill = { key: string; text: string; tick: number };

/**
 * The held prefill after the route changes: a new `?prefill=` replaces it (with a fresh tick); the same
 * conversation, its address tidied, keeps it; anywhere else drops it, so no other conversation — nor this
 * one opened again later — gets it written over its draft.
 */
export function nextPrefill(held: Prefill | null, conv: { agentId: string; conversationId: string; prefill: string | null } | null, tick: number): Prefill | null {
  if (!conv) return null;
  const key = draftKey(conv.agentId, conv.conversationId);
  if (conv.prefill) return { key, text: conv.prefill, tick };
  return held?.key === key ? held : null;
}

// ---- Recents --------------------------------------------------------------------------------------

// Shared with the desktop (shared/recents.ts); the phone's histories keep their own storage keys below.
export { createRecents, pushRecent, sanitizeRecents, type RecentEntry } from "../shared/recents";

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
      // the id first; a remounted screen may give it a new id, so data-launch is the fallback, not an alternative
      const byId = hit.id ? document.getElementById(hit.id) : null;
      if (byId || !hit.launch) return byId;
      const launch = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(hit.launch) : hit.launch.replace(/["\\]/g, "\\$&");
      return document.querySelector(`[data-launch="${launch}"]`);
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

/** On screen: it has a box, and is not in a screen kept mounted but away (the Inbox hides with visibility, which keeps its box). */
const visible = (el: Element) => el.getClientRects().length > 0 && !el.closest("[data-away], [hidden]");

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
