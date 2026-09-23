import type { AttentionItem } from "../../../core/attention/model.ts";
import { catchUpQueue } from "../../../core/attention/queue.ts";
import type { DeskSummary } from "../desk/useDesk";
import { buildSearchIndex, groupHits, rankHits, type HitGroup, type Indexed, type SearchIndex as CoreIndex } from "../shared/search";
import type { IconName } from "./icons";
import { formatRoute, parseRoute, type Route } from "./router";

/**
 * The phone's Search, pure (test/phone-search.test.ts): it looks only at what the phone already holds,
 * in declared fields — a desk's title and agent, an agent's name and (once loaded) description, a waiting
 * Inbox item's title and agent, and the named pages. Never a transcript, never a call to the Mac.
 *
 * Ranking is shared/search.ts's one rule: the best tier any field reaches (exact, prefix, word start,
 * substring), a title before a secondary field at the same tier, then the newest, then the order the list
 * already had. This file is the phone's adapter: its hits, routes and pages. Search.tsx draws the groups with the same rows as Home, Agents and More.
 */

/** Rows per group; the group says how many matched in all. */
export const GROUP_MAX = 5;

export type GroupId = "desks" | "agents" | "inbox" | "pages";
const GROUP_TITLE: Record<GroupId, string> = { desks: "Desks", agents: "Agents", inbox: "Inbox", pages: "Pages" };
const GROUP_ORDER: GroupId[] = ["desks", "agents", "inbox", "pages"];

/** What the row starts with: the agent's face, or an icon. */
export type Lead = { agent: { id: string; name: string } } | { icon: IconName };

export interface Hit {
  key: string;
  group: GroupId;
  title: string;
  preview: string;
  route: Route;
  lead: Lead;
  /** Drawn quieter: an archived desk. */
  dim: boolean;
}

/** A group of hits; `hits` holds the first GROUP_MAX of `total`. */
export type Group = HitGroup<Hit, GroupId>;

/** What the phone has loaded, from Phone.tsx: the desks list, the agent list, the attention items, and agent descriptions the Agents cache already holds. */
export interface SearchSources {
  desks: DeskSummary[];
  agents: Array<{ id: string; name: string }>;
  items: AttentionItem[];
  describe?: (agentId: string) => string | null | undefined;
}

/** A named page, and the words people use for it. */
export interface Destination {
  route: Route;
  icon: IconName;
  label: string;
  line: string;
  keywords: string[];
}

/** The places Search can open by name: the tabs and the pages under Home and More. */
export const DESTINATIONS: readonly Destination[] = [
  { route: { kind: "tab", tab: "home" }, icon: "home", label: "Home", line: "Desks and what needs you", keywords: ["desks", "start"] },
  { route: { kind: "tab", tab: "inbox" }, icon: "inbox", label: "Inbox", line: "What waits on you", keywords: ["catch up", "waiting", "approvals", "activity"] },
  { route: { kind: "tab", tab: "agents" }, icon: "agents", label: "Agents", line: "Every agent on the Mac", keywords: ["dms", "people"] },
  { route: { kind: "tab", tab: "more" }, icon: "more", label: "More", line: "This phone and the paired Mac", keywords: ["you", "profile"] },
  { route: { kind: "learn" }, icon: "learn", label: "Learn", line: "What your agents learned, to review", keywords: ["recall", "cards", "lessons", "review"] },
  { route: { kind: "archive" }, icon: "archive", label: "Archived desks", line: "Desks put away, to restore", keywords: ["archive", "restore", "old desks"] },
  { route: { kind: "preferences" }, icon: "settings", label: "Preferences", line: "Appearance", keywords: ["settings", "appearance", "theme", "dark mode", "light mode"] },
  { route: { kind: "connection" }, icon: "link", label: "Connection details", line: "The paired Mac and this phone's pairing", keywords: ["paired mac", "pairing", "wi-fi", "tailscale", "unpair", "network"] },
  { route: { kind: "about" }, icon: "info", label: "About loki", line: "Version and build", keywords: ["version", "build", "updates"] },
];

// ---- Queries --------------------------------------------------------------------------------------

// The matcher and ranker are shared with the desktop's search (shared/search.ts); the phone keeps its names.
export { MAX_QUERY, cleanQuery, normalize, tierOf } from "../shared/search";

// ---- The index ------------------------------------------------------------------------------------

/** Home's name for a desk: its title, else "new desk" while live, else its scope. */
const deskTitle = (d: DeskSummary): string => d.title ?? (d.status === "live" ? "new desk" : d.scope);
const time = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
};
/** What an Inbox item waits on, in the Inbox's words. */
const WAITS: Record<string, string> = { approval: "needs approval", question: "asked you", failed: "failed", done: "finished" };

type Entry = Indexed<Hit>;

const deskHit = (d: DeskSummary & { agentId: string; conversationId: string }): Hit => ({
  key: `desk:${d.agentId}/${d.conversationId}`,
  group: "desks",
  title: deskTitle(d),
  preview: d.status === "live" ? (d.agentName ?? "agent") : `${d.agentName ?? "agent"} · ${d.status}`,
  route: { kind: "conversation", agentId: d.agentId, conversationId: d.conversationId, prefill: null },
  lead: { icon: d.status === "live" ? "desk" : "archive" },
  dim: d.status !== "live",
});
const agentHit = (a: { id: string; name: string }, description: string | null | undefined): Hit => ({
  key: `agent:${a.id}`,
  group: "agents",
  title: a.name,
  preview: description || "Agent",
  route: { kind: "agent", agentId: a.id },
  lead: { agent: { id: a.id, name: a.name } },
  dim: false,
});
const itemHit = (i: AttentionItem): Hit => ({
  key: `inbox:${i.agentId}/${i.id}`,
  group: "inbox",
  title: i.title || "Untitled conversation",
  preview: [i.agentName ?? "agent", WAITS[i.status], i.snooze ? "later" : null].filter(Boolean).join(" · "),
  route: { kind: "conversation", agentId: i.agentId, conversationId: i.id, prefill: null },
  lead: { agent: { id: i.agentId, name: i.agentName ?? "agent" } },
  dim: false,
});
const pageHit = (d: Destination): Hit => ({ key: `page:${formatRoute(d.route)}`, group: "pages", title: d.label, preview: d.line, route: d.route, lead: { icon: d.icon }, dim: false });

const openable = (d: DeskSummary): d is DeskSummary & { agentId: string; conversationId: string } => !!d.agentId && !!d.conversationId;

/** The sources as searchable entries, fields folded: build once per sources (Search.tsx memoizes it), query per keystroke. */
export type SearchIndex = CoreIndex<Hit>;

export function buildIndex(src: SearchSources): SearchIndex {
  const out: Entry[] = [];
  for (const d of src.desks) if (openable(d)) out.push({ hit: deskHit(d), fields: [deskTitle(d), d.agentName ?? ""], recency: time(d.lastActive) });
  for (const a of src.agents) {
    const description = src.describe?.(a.id) ?? null;
    out.push({ hit: agentHit(a, description), fields: [a.name, description ?? ""], recency: 0 });
  }
  // The loaded actionable items, the Later ones included: what the Inbox holds, not every conversation.
  for (const i of catchUpQueue(src.items, true)) out.push({ hit: itemHit(i), fields: [i.title ?? "", i.agentName ?? ""], recency: time(i.lastMessageAt) });
  for (const d of DESTINATIONS) out.push({ hit: pageHit(d), fields: [d.label, ...d.keywords], recency: 0 });
  return buildSearchIndex(out);
}

/** The groups for a query, in a fixed order, empty ones left out; a blank query is none (the recents show instead). */
export function search(src: SearchSources | SearchIndex, raw: string, max = GROUP_MAX): Group[] {
  const idx = "entries" in src ? src : buildIndex(src);
  return groupHits(rankHits(idx, raw), (h) => h.group, GROUP_ORDER, GROUP_TITLE, max);
}

// ---- Recently visited -----------------------------------------------------------------------------

/** A remembered route hash as the row that opens it, or null when it no longer resolves (a desk deleted, an agent gone, junk). */
export function placeHit(hash: string, src: SearchSources): Hit | null {
  const r = parseRoute(hash);
  if (formatRoute(r) !== hash || r.kind === "search") return null; // not an address the app writes
  const page = DESTINATIONS.find((d) => formatRoute(d.route) === hash);
  if (page) return pageHit(page);
  if (r.kind === "agent" || r.kind === "file") {
    const a = src.agents.find((x) => x.id === r.agentId);
    if (!a) return null;
    if (r.kind === "agent") return agentHit(a, src.describe?.(a.id));
    return { key: `file:${hash}`, group: "agents", title: r.path.split("/").pop() || r.path, preview: `${a.name} · memory`, route: r, lead: { icon: "file" }, dim: false };
  }
  if (r.kind === "conversation") {
    const d = src.desks.find((x) => x.agentId === r.agentId && x.conversationId === r.conversationId);
    if (d && openable(d)) return deskHit(d);
    const i = src.items.find((x) => x.agentId === r.agentId && x.id === r.conversationId);
    return i ? itemHit(i) : null;
  }
  return null;
}

/** For recentPlaces.read(valid): drops what no longer resolves at read time, so it never becomes a broken row. */
export const isPlace = (hash: string, src: SearchSources): boolean => placeHit(hash, src) !== null;

/** The recent places as rows, the stale ones gone. */
export function recentPlaceHits(hashes: string[], src: SearchSources): Hit[] {
  return hashes.map((h) => placeHit(h, src)).filter((h): h is Hit => h !== null);
}
