import { useEffect, useState } from "react";

/**
 * The phone's routes live in the hash, so a home-screen icon has history and swipe-back:
 *   #/home  #/inbox  #/agents  #/you                  the four tabs
 *   #/learn                                           Learn, opened from Home
 *   #/agents/<agentId>                             an agent's page
 *   #/agents/<agentId>/file/<path>                 one memory file (path segments kept readable, each encoded)
 *   #/c/<agentId>/<conversationId>[?prefill=…]     a conversation; `prefill` starts the reply box
 * parse/format are pure (test/phone-router.test.ts); useRoute() follows hashchange.
 */

export type Tab = "home" | "inbox" | "agents" | "you";
export const TABS: readonly Tab[] = ["home", "inbox", "agents", "you"];

export type Route =
  | { kind: "tab"; tab: Tab }
  | { kind: "learn" }
  | { kind: "agent"; agentId: string }
  | { kind: "file"; agentId: string; path: string }
  | { kind: "conversation"; agentId: string; conversationId: string; prefill: string | null };

export const HOME: Route = { kind: "tab", tab: "home" };

const isTab = (s: string): s is Tab => (TABS as readonly string[]).includes(s);

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
  if (parts.length === 1 && head === "settings") return { kind: "tab", tab: "you" };
  if (parts.length === 1 && head === "learn") return { kind: "learn" };
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
      return "#/learn";
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

/** The tab a route belongs to; a conversation belongs to none (it is reached from home or the inbox). */
export function tabOf(r: Route): Tab | null {
  if (r.kind === "tab") return r.tab;
  if (r.kind === "learn") return "home";
  if (r.kind === "agent" || r.kind === "file") return "agents";
  return null;
}

/** Routes that cover the whole screen and hide the tab bar. */
export function isOverlay(r: Route): boolean {
  return r.kind !== "tab";
}

/** In-app pushes since load, so back() knows whether history.back() stays inside the app. */
let pushes = 0;
let expected: string | null = null;

/** Go somewhere (a new history entry). */
export function navigate(r: Route): void {
  const hash = formatRoute(r);
  if (location.hash === hash) return;
  expected = hash;
  pushes++;
  location.hash = hash;
}

/** Swap the current entry. */
export function replace(r: Route): void {
  const hash = formatRoute(r);
  expected = hash;
  history.replaceState(history.state, "", `${location.pathname}${location.search}${hash}`);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  expected = null; // dispatch is synchronous: whoever listens has consumed it
}

/** Back to where we came from inside the app; to `fallback` when this is where the app was opened. */
export function back(fallback: Route): void {
  if (pushes > 0) history.back();
  else replace(fallback);
}

/** The current route, following hashchange. An empty hash becomes #/home without a history entry. */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  useEffect(() => {
    if (!location.hash) replace(HOME);
    const on = () => {
      const h = location.hash;
      if (expected !== null && h === expected) expected = null;
      else pushes = Math.max(0, pushes - 1); // a pop (back, swipe-back) or a typed address
      setRoute(parseRoute(h));
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}
