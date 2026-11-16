import { useEffect, useEffectEvent, useLayoutEffect, useRef, type RefObject } from "react";
import { draftKey } from "../shared/drafts";
import { createRecents } from "../shared/recents";

export interface Prefill {
  key: string;
  text: string;
  tick: number;
}

export function nextPrefill(
  held: Prefill | null,
  conv: { agentId: string; conversationId: string; prefill: string | null } | null,
  tick: number,
): Prefill | null {
  if (!conv) return null;
  const key = draftKey(conv.agentId, conv.conversationId);
  if (conv.prefill) return { key, text: conv.prefill, tick };
  return held?.key === key ? held : null;
}

export { createRecents, pushRecent, sanitizeRecents, type RecentEntry } from "../shared/recents";

export const recentSearches = createRecents({ key: "loki.phone.recentSearches", max: 8 });
export const recentPlaces = createRecents({ key: "loki.phone.recentPlaces", max: 8 });

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
    const ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
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
      const byId = hit.id ? document.getElementById(hit.id) : null;
      if (byId || !hit.launch) return byId;
      const launch = typeof CSS !== "undefined" ? CSS.escape(hit.launch) : hit.launch.replace(/["\\]/g, "\\$&");
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

const visible = (el: Element) => el.getClientRects().length > 0 && !el.closest("[data-away], [hidden]");

export function restoreFocus(root: Element, hash: string, returning: boolean, memory = focusMemory) {
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

export function useFocusOnRoute(root: RefObject<HTMLElement | null>, routeKey: string, returning: boolean) {
  const first = useRef(true);
  const restore = useEffectEvent((key: string) => {
    if (root.current) restoreFocus(root.current, key, returning);
  });
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    restore(routeKey);
  }, [routeKey]);
}
