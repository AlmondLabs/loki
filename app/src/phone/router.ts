import { useEffect, useState } from "react";
import { parentChatOfSubagent } from "../../../core/subagents.ts";
import { activeControl, focusMemory } from "./session";
import { expectPop, transition } from "./transitions";

export type Tab = "home" | "flow" | "agents" | "more";
export const TABS: readonly Tab[] = ["home", "flow", "agents", "more"];

export type Route =
  | { kind: "tab"; tab: Tab }
  | { kind: "goals" }
  | { kind: "learn"; view?: LearnPage }
  | { kind: "search"; q?: string }
  | { kind: "archive" }
  | { kind: "preferences" }
  | { kind: "usage" }
  | { kind: "connection" }
  | { kind: "about" }
  | { kind: "agent"; agentId: string }
  | { kind: "file"; agentId: string; path: string }
  | { kind: "conversation"; agentId: string; conversationId: string; prefill: string | null };

export const HOME: Route = { kind: "tab", tab: "home" };

export type LearnPage = "review" | "leads" | "lessons" | "deleted";
export const LEARN_PAGES: readonly LearnPage[] = ["review", "leads", "lessons", "deleted"];
const isLearnPage = (s: string): s is LearnPage => (LEARN_PAGES as readonly string[]).includes(s);

const isTab = (s: string): s is Tab => (TABS as readonly string[]).includes(s);
const CHILDREN = ["goals", "learn", "archive", "preferences", "usage", "connection", "about"] as const;
type Child = (typeof CHILDREN)[number];
const isChild = (s: string): s is Child => (CHILDREN as readonly string[]).includes(s);
const LEGACY: Record<string, Route> = { you: { kind: "tab", tab: "more" }, settings: { kind: "preferences" }, inbox: { kind: "tab", tab: "flow" } };

const dec = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

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
  if (parts.length === 2 && head === "learn" && isLearnPage(a)) return { kind: "learn", view: a };
  if (parts.length === 1 && head === "search") {
    const q = new URLSearchParams(query).get("q");
    return q ? { kind: "search", q } : { kind: "search" };
  }
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

export function formatRoute(r: Route): string {
  switch (r.kind) {
    case "tab":
      return `#/${r.tab}`;
    case "search":
      return r.q ? `#/search?q=${encodeURIComponent(r.q)}` : "#/search";
    case "learn":
      return r.view ? `#/learn/${r.view}` : "#/learn";
    case "goals":
    case "archive":
    case "preferences":
    case "usage":
    case "connection":
    case "about":
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

export function ownerOf(r: Route): Tab {
  switch (r.kind) {
    case "tab":
      return r.tab;
    case "preferences":
    case "usage":
    case "connection":
    case "about":
      return "more";
    case "agent":
    case "file":
      return "agents";
    default:
      return "home";
  }
}

export function parentOf(r: Route): Route {
  if (r.kind === "file") return { kind: "agent", agentId: r.agentId };
  if (r.kind === "conversation") {
    const parent = parentChatOfSubagent(r.conversationId);
    if (parent !== null) return { kind: "conversation", agentId: r.agentId, conversationId: parent, prefill: null };
  }
  if (r.kind === "learn" && r.view) return { kind: "learn" };
  return { kind: "tab", tab: ownerOf(r) };
}

export function backTarget(r: Route, from: Route | null): Route {
  return from && formatRoute(from) !== formatRoute(r) ? from : parentOf(r);
}

export function showsNav(r: Route): boolean {
  return r.kind === "tab";
}

export function isOverlay(r: Route): boolean {
  return !showsNav(r);
}

export function screenOf(r: Route): string {
  return r.kind === "tab" ? r.tab : r.kind;
}

export function labelOf(r: Route): string {
  const screen = screenOf(r);
  return screen === "flow" ? "flow" : screen;
}

interface Stamp {
  lokiFrom: string;
  lokiDepth: number;
}

const stampOf = (state: unknown): Stamp | null => {
  if (!state || typeof state !== "object") return null;
  const { lokiFrom, lokiDepth } = state as Record<string, unknown>;
  return typeof lokiFrom === "string" && typeof lokiDepth === "number" && lokiDepth > 0 ? { lokiFrom, lokiDepth } : null;
};

export function entryState(prev: unknown, fromHash: string): Record<string, unknown> {
  const base = prev && typeof prev === "object" ? (prev as Record<string, unknown>) : {};
  return { ...base, lokiFrom: fromHash, lokiDepth: depthOf(prev) + 1 };
}

export function originOf(state: unknown): Route | null {
  const s = stampOf(state);
  return s ? parseRoute(s.lokiFrom) : null;
}

export function depthOf(state: unknown): number {
  return stampOf(state)?.lokiDepth ?? 0;
}

export type Arrival = "push" | "pop" | "replace" | "load";
let pending: Arrival | null = null;

const url = (hash: string) => `${location.pathname}${location.search}${hash}`;

export const openConversation = (agentId: string, conversationId: string): void => navigate({ kind: "conversation", agentId, conversationId, prefill: null });

export function navigate(r: Route): void {
  const hash = formatRoute(r);
  if (location.hash === hash) return;
  focusMemory.remember(location.hash, activeControl());
  history.pushState(entryState(history.state, location.hash), "", url(hash));
  pending = "push";
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

export function replace(r: Route, arrival: Arrival = "replace"): void {
  history.replaceState(history.state, "", url(formatRoute(r)));
  pending = arrival;
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

export function rewrite(r: Route): void {
  const hash = formatRoute(r);
  if (location.hash !== hash) history.replaceState(history.state, "", url(hash));
}

export function back(r: Route): void {
  expectPop();
  if (depthOf(history.state) > 0) history.back();
  else replace(backTarget(r, null), "pop");
}

export interface RouteState {
  route: Route;
  from: Route | null;
  arrival: Arrival;
}

const read = (arrival: Arrival): RouteState => ({ route: parseRoute(location.hash), from: originOf(history.state), arrival });

export function useRouteState(): RouteState {
  const [state, setState] = useState<RouteState>(() => read("load"));
  useEffect(() => {
    const canonicalize = () => {
      const canonical = formatRoute(parseRoute(location.hash));
      if (location.hash !== canonical) history.replaceState(history.state, "", url(canonical));
    };
    canonicalize();
    let shown = parseRoute(location.hash);
    const on = () => {
      const arrival = pending ?? "pop";
      pending = null;
      canonicalize();
      const next = read(arrival);
      const from = shown;
      shown = next.route;
      transition(from, next.route, arrival, () => setState(next));
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return state;
}
