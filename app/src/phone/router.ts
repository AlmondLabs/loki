import { useEffect, useState } from "react";
import { activeControl, focusMemory } from "./session";

/**
 * The phone's routes live in the hash, so a home-screen icon has history and swipe-back:
 *   #/home  #/inbox  #/agents  #/more                 the four tabs
 *   #/search                                          Search, from the round button beside the tabs
 *   #/learn  #/archive                                Learn and the archived desks (Home's shortcuts, More's rows)
 *   #/preferences                                     preferences and connection, under More
 *   #/agents/<agentId>                             an agent's page
 *   #/agents/<agentId>/file/<path>                 one memory file (path segments kept readable, each encoded)
 *   #/c/<agentId>/<conversationId>[?prefill=…]     a conversation; `prefill` starts the reply box
 * Legacy addresses still land: #/you is More, #/settings is preferences (useRoute swaps the address).
 *
 * Every route has an owning tab (ownerOf) and a direct-link parent (parentOf). A page opened from inside
 * the app also carries where it was opened from, in its history entry: navigate() stamps the entry with
 * the origin's hash and the depth of in-app pushes, so Back can use history (iOS swipe-back included)
 * while a page opened cold — a saved link, a home-screen launch — falls back to its parent instead of
 * leaving the app. parse/format and the entry helpers are pure (test/phone-router.test.ts).
 */

export type Tab = "home" | "inbox" | "agents" | "more";
export const TABS: readonly Tab[] = ["home", "inbox", "agents", "more"];

export type Route =
  | { kind: "tab"; tab: Tab }
  | { kind: "learn" }
  | { kind: "search" }
  | { kind: "archive" }
  | { kind: "preferences" }
  | { kind: "agent"; agentId: string }
  | { kind: "file"; agentId: string; path: string }
  | { kind: "conversation"; agentId: string; conversationId: string; prefill: string | null };

export const HOME: Route = { kind: "tab", tab: "home" };

const isTab = (s: string): s is Tab => (TABS as readonly string[]).includes(s);
/** Single-segment pages that are not tabs. */
const CHILDREN = ["learn", "search", "archive", "preferences"] as const;
type Child = (typeof CHILDREN)[number];
const isChild = (s: string): s is Child => (CHILDREN as readonly string[]).includes(s);
/** Old addresses, from saved links and installed clients, to where they live now. */
const LEGACY: Record<string, Route> = { you: { kind: "tab", tab: "more" }, settings: { kind: "preferences" } };

const dec = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** A hash (with or without the leading `#`) to a route; anything unknown is home. */
export function parseRoute(hash: string): Route {
  let h = hash.startsWith("#") ? hash.slice(1) : hash;
  let query = "";
  const qi = h.indexOf("?");
  if (qi >= 0) {
    query = h.slice(qi + 1);
    h = h.slice(0, qi);
  }
  const parts = h.split("/").filter(Boolean);
  if (parts.length === 0) return HOME;
  const [head, a, b, ...rest] = parts;
  if (parts.length === 1 && Object.hasOwn(LEGACY, head)) return LEGACY[head];
  if (parts.length === 1 && isChild(head)) return { kind: head };
  if (parts.length === 1 && isTab(head)) return { kind: "tab", tab: head };
  if (head === "agents" && a) {
    const agentId = dec(a);
    if (!b) return { kind: "agent", agentId };
    if (b === "file" && rest.length) return { kind: "file", agentId, path: rest.map(dec).join("/") };
    return { kind: "agent", agentId };
  }
  if (head === "c" && a && b) {
    const prefill = new URLSearchParams(query).get("prefill");
    return { kind: "conversation", agentId: dec(a), conversationId: dec(b), prefill: prefill || null };
  }
  return HOME;
}

/** A route to its hash, `#` included. */
export function formatRoute(r: Route): string {
  switch (r.kind) {
    case "tab":
      return `#/${r.tab}`;
    case "learn":
    case "search":
    case "archive":
    case "preferences":
      return `#/${r.kind}`;
    case "agent":
      return `#/agents/${encodeURIComponent(r.agentId)}`;
    case "file":
      return `#/agents/${encodeURIComponent(r.agentId)}/file/${r.path.split("/").map(encodeURIComponent).join("/")}`;
    case "conversation": {
      const base = `#/c/${encodeURIComponent(r.agentId)}/${encodeURIComponent(r.conversationId)}`;
      return r.prefill ? `${base}?prefill=${encodeURIComponent(r.prefill)}` : base;
    }
  }
}

/** The tab a route lives under. Learn, Archive and Search hang off Home; preferences off More; a conversation is Home's. */
export function ownerOf(r: Route): Tab {
  switch (r.kind) {
    case "tab":
      return r.tab;
    case "preferences":
      return "more";
    case "agent":
    case "file":
      return "agents";
    default:
      return "home";
  }
}

/** Where Back goes when the page was opened cold: a file to its agent, everything else to its owning tab. */
export function parentOf(r: Route): Route {
  if (r.kind === "file") return { kind: "agent", agentId: r.agentId };
  return { kind: "tab", tab: ownerOf(r) };
}

/** Back's destination: where the page was opened from, else its parent. */
export function backTarget(r: Route, from: Route | null): Route {
  return from && formatRoute(from) !== formatRoute(r) ? from : parentOf(r);
}

/** The floating navigation shows on the four tabs; pages take the whole screen. */
export function showsNav(r: Route): boolean {
  return r.kind === "tab";
}

/** Routes that cover the whole screen and hide the navigation. */
export function isOverlay(r: Route): boolean {
  return !showsNav(r);
}

/** The route's name for analytics (`view`, `$screen`): a tab or a page kind, never which desk, agent or file. */
export function screenOf(r: Route): string {
  return r.kind === "tab" ? r.tab : r.kind;
}

/** How a Back control names where it goes: "back to inbox". */
export function labelOf(r: Route): string {
  return screenOf(r);
}

// ---- History entries ------------------------------------------------------------------------------

/** What navigate() stamps on the entry it pushes, beside whatever state was there. */
type Stamp = { lokiFrom: string; lokiDepth: number };

const stampOf = (state: unknown): Stamp | null => {
  if (!state || typeof state !== "object") return null;
  const { lokiFrom, lokiDepth } = state as Record<string, unknown>;
  return typeof lokiFrom === "string" && typeof lokiDepth === "number" && lokiDepth > 0 ? { lokiFrom, lokiDepth } : null;
};

/** The state for an entry pushed from `fromHash`, one deeper than the entry it leaves. */
export function entryState(prev: unknown, fromHash: string): Record<string, unknown> {
  const base = prev && typeof prev === "object" ? (prev as Record<string, unknown>) : {};
  return { ...base, lokiFrom: fromHash, lokiDepth: depthOf(prev) + 1 };
}

/** The route this entry was opened from, or null for an entry the app did not push. */
export function originOf(state: unknown): Route | null {
  const s = stampOf(state);
  return s ? parseRoute(s.lokiFrom) : null;
}

/** In-app pushes behind this entry: above zero, history.back() stays in the app. */
export function depthOf(state: unknown): number {
  return stampOf(state)?.lokiDepth ?? 0;
}

// ---- Effects --------------------------------------------------------------------------------------

/** How the route on screen was reached: a push, a pop (Back, swipe-back, a Back fallback), a swap, or the load. */
export type Arrival = "push" | "pop" | "replace" | "load";
let pending: Arrival | null = null;

const url = (hash: string) => `${location.pathname}${location.search}${hash}`;

/** Go somewhere: a new history entry that remembers where it came from and the control that launched it. */
export function navigate(r: Route): void {
  const hash = formatRoute(r);
  if (location.hash === hash) return;
  focusMemory.remember(location.hash, activeControl());
  history.pushState(entryState(history.state, location.hash), "", url(hash));
  pending = "push";
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/** Swap the current entry, keeping its origin. */
export function replace(r: Route, arrival: Arrival = "replace"): void {
  history.replaceState(history.state, "", url(formatRoute(r)));
  pending = arrival;
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/** Back to where this page was opened from; to its parent when the app was opened on it. */
export function back(r: Route): void {
  if (depthOf(history.state) > 0) history.back();
  else replace(backTarget(r, null), "pop");
}

export type RouteState = { route: Route; from: Route | null; arrival: Arrival };

const read = (arrival: Arrival): RouteState => ({ route: parseRoute(location.hash), from: originOf(history.state), arrival });

/** The current route, where it was opened from, and how it arrived, following hashchange. */
export function useRouteState(): RouteState {
  const [state, setState] = useState<RouteState>(() => read("load"));
  useEffect(() => {
    // An empty, legacy or unknown address is swapped for the canonical one, without an entry.
    const canonicalize = () => {
      const canonical = formatRoute(parseRoute(location.hash));
      if (location.hash !== canonical) history.replaceState(history.state, "", url(canonical));
    };
    canonicalize();
    const on = () => {
      const arrival = pending ?? "pop"; // nothing pending: history moved by itself (Back, swipe-back, a typed address)
      pending = null;
      canonicalize();
      setState(read(arrival));
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return state;
}

/** Just the route. */
export function useRoute(): Route {
  return useRouteState().route;
}
