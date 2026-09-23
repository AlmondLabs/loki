import type { AttentionItem } from "../../../core/attention/model.ts";
import { catchUpQueue } from "../../../core/attention/queue.ts";
import { scopeFor } from "../../../core/desk-core.ts";
import type { DeskSummary } from "../desk/useDesk";
import { buildSearchIndex, groupHits, rankHits, type HitGroup, type Indexed, type SearchIndex as CoreIndex } from "../shared/search";
import { createRecents } from "../shared/recents";
import type { IconName } from "../shared/icons";
import { PAGES, pageTitle, type SettingsPage } from "../settings/pages";
import type { Segment } from "./keymap";

/**
 * The desktop's ⌘K search, pure (test/desktop-search.test.ts; plan 013 U9): the desktop's adapter over
 * shared/search.ts, as phone/searchIndex.ts is the phone's. It looks only at what the window holds, in
 * declared fields — a desk's title and agent, an agent's name, a waiting Inbox item's title and agent, the
 * named pages. Never a transcript. A hit carries where it goes (`target`); Shell.tsx does the going.
 *
 * Groups come in the order of their best hit, so the first row drawn is the top result Enter opens.
 */

/** Rows per group; the group says how many matched in all. */
export const GROUP_MAX = 5;

/** What search covers, said wherever it could pass for message search (the phone says the same). */
export const COVERAGE = "Searches desk titles, agents, waiting items and pages — not message text.";

export type GroupId = "desks" | "agents" | "waiting" | "pages";
const GROUP_TITLE: Record<GroupId, string> = { desks: "Desks", agents: "Agents", waiting: "Waiting", pages: "Pages" };

/**
 * Where a hit goes. A desk opens on Messages with the box focused (Shell's openDesk). A waiting item opens
 * its desk on Messages too, where the question or approval shows in the thread, rather than dropping into
 * the Inbox pass mid-queue. An agent opens Agents on that agent; a page, its section or Preferences on that page.
 */
export type SearchTarget = { kind: "desk"; agentId: string; conversationId: string } | { kind: "agent"; agentId: string } | { kind: "section"; segment: Exclude<Segment, "settings"> } | { kind: "preferences"; page: SettingsPage | null };

/** What the row starts with: the agent's face, or an icon. */
export type Lead = { agent: { id: string; name: string } } | { icon: IconName };

export interface SearchHit {
  /** Stable, for React and the row's data-launch. */
  key: string;
  /** What the recent places store when it is opened: a waiting item is remembered as its desk. */
  place: string;
  group: GroupId;
  title: string;
  preview: string;
  target: SearchTarget;
  lead: Lead;
  /** Drawn quieter: an archived desk. */
  dim: boolean;
}

export type SearchGroup = HitGroup<SearchHit, GroupId>;

/** What the window has loaded: the desks list, the agents, the attention items. */
export interface SearchSources {
  desks: DeskSummary[];
  agents: Array<{ id: string; name: string }>;
  items: AttentionItem[];
}

/** A named page, and the words people use for it. */
interface Page {
  key: string;
  target: SearchTarget;
  icon: IconName;
  label: string;
  line: string;
  keywords: string[];
}

/** Words for the Preferences pages beyond their names. */
const PREF_WORDS: Partial<Record<SettingsPage, string[]>> = {
  letta: ["harness", "letta code", "mod", "version", "update", "install"],
  inbox: ["later", "snooze"],
  providers: ["models", "api key", "openai", "anthropic"],
  phone: ["pairing", "wi-fi", "lan"],
  appearance: ["theme", "dark mode", "light mode"],
  learn: ["recall", "cards"],
  keys: ["shortcuts", "keyboard"],
};

/** The places search opens by name: the rail's sections, Preferences, and each Preferences page. */
export const DESTINATIONS: readonly Page[] = [
  { key: "page:desk", target: { kind: "section", segment: "desk" }, icon: "desk", label: "Desk", line: "The desk you were on", keywords: ["desks", "canvas", "home"] },
  { key: "page:inbox", target: { kind: "section", segment: "inbox" }, icon: "inbox", label: "Inbox", line: "What waits on you", keywords: ["catch up", "waiting", "approvals"] },
  { key: "page:board", target: { kind: "section", segment: "board" }, icon: "check", label: "Board", line: "Tasks for your agents", keywords: ["tasks", "todo", "kanban"] },
  { key: "page:agents", target: { kind: "section", segment: "agents" }, icon: "agents", label: "Agents", line: "Every agent on this Mac", keywords: ["dms", "people", "memory"] },
  { key: "page:learn", target: { kind: "section", segment: "learn" }, icon: "learn", label: "Learn", line: "What your agents learned, to review", keywords: ["recall", "cards", "lessons", "review"] },
  { key: "prefs", target: { kind: "preferences", page: null }, icon: "settings", label: "Preferences", line: "Settings", keywords: ["settings"] },
  ...PAGES.map(({ id }) => ({ key: `prefs:${id}`, target: { kind: "preferences", page: id } as SearchTarget, icon: "settings" as IconName, label: pageTitle(id), line: "Preferences", keywords: PREF_WORDS[id] ?? [] })),
];

/** The recent places, the desktop's own key (the phone's are loki.phone.*). */
export const PLACES_KEY = "loki.desktop.recentPlaces";
export const recentPlaces = createRecents({ key: PLACES_KEY, max: 8 });

// ---- hits -----------------------------------------------------------------------------------------

type OpenableDesk = DeskSummary & { agentId: string; conversationId: string };
/** Desks search can open: a real conversation, not the shared scope, not deleted. */
const openable = (d: DeskSummary): d is OpenableDesk => !!d.agentId && !!d.conversationId && d.status !== "deleted";

/** The sidebar's name for a desk (DeskSidebar): its title, else Main chat, New desk, or its scope. */
const deskTitle = (d: DeskSummary): string => d.title ?? (d.conversationId === "default" ? "Main chat" : d.status === "live" ? "New desk" : d.scope);
const time = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
};
/** What an Inbox item waits on, in the Inbox's words. */
const WAITS: Record<string, string> = { approval: "needs approval", question: "asked you", failed: "failed", done: "finished" };

const agentNamer = (src: SearchSources) => {
  const names = new Map(src.agents.map((a) => [a.id, a.name]));
  return (id: string, fallback: string | null | undefined) => names.get(id) ?? fallback ?? "Agent";
};

const deskHit = (d: OpenableDesk, agentName: string): SearchHit => ({
  key: `desk:${d.scope}`,
  place: `desk:${d.scope}`,
  group: "desks",
  title: deskTitle(d),
  preview: d.status === "live" ? agentName : `${agentName} · archived`,
  target: { kind: "desk", agentId: d.agentId, conversationId: d.conversationId },
  lead: { icon: d.status === "live" ? "desk" : "archive" },
  dim: d.status !== "live",
});
const agentHit = (a: { id: string; name: string }): SearchHit => ({ key: `agent:${a.id}`, place: `agent:${a.id}`, group: "agents", title: a.name, preview: "Agent", target: { kind: "agent", agentId: a.id }, lead: { agent: a }, dim: false });
const itemHit = (i: AttentionItem, agentName: string): SearchHit => ({
  key: `waiting:${i.agentId}/${i.id}`,
  place: deskPlace(scopeFor(i.id, i.agentId)),
  group: "waiting",
  title: i.title || "Untitled conversation",
  preview: [agentName, WAITS[i.status], i.snooze ? "later" : null].filter(Boolean).join(" · "),
  target: { kind: "desk", agentId: i.agentId, conversationId: i.id },
  lead: { agent: { id: i.agentId, name: agentName } },
  dim: false,
});
const pageHit = (p: Page): SearchHit => ({ key: p.key, place: p.key, group: "pages", title: p.label, preview: p.line, target: p.target, lead: { icon: p.icon }, dim: false });

// ---- the index ------------------------------------------------------------------------------------

export type SearchIndex = CoreIndex<SearchHit>;

/** The sources as searchable entries, fields folded: build once per sources, query per keystroke. */
export function buildIndex(src: SearchSources): SearchIndex {
  const name = agentNamer(src);
  const out: Indexed<SearchHit>[] = [];
  for (const d of src.desks) if (openable(d)) out.push({ hit: deskHit(d, name(d.agentId, d.agentName)), fields: [deskTitle(d), name(d.agentId, d.agentName)], recency: time(d.lastActive) });
  for (const a of src.agents) out.push({ hit: agentHit(a), fields: [a.name], recency: 0 });
  // The actionable items, Later included: what the Inbox holds, not every conversation.
  for (const i of catchUpQueue(src.items, true)) {
    const n = name(i.agentId, i.agentName);
    out.push({ hit: itemHit(i, n), fields: [i.title ?? "", n], recency: time(i.lastMessageAt) });
  }
  for (const p of DESTINATIONS) out.push({ hit: pageHit(p), fields: [p.label, ...p.keywords], recency: 0 });
  return buildSearchIndex(out);
}

/** The groups for a query, each in the order of its best hit, empty ones left out; a blank query is none (the recents show instead). */
export function search(idx: SearchIndex, raw: string, max = GROUP_MAX): SearchGroup[] {
  const hits = rankHits(idx, raw);
  const order = [...new Set(hits.map((h) => h.group))];
  return groupHits(hits, (h) => h.group, order, GROUP_TITLE, max);
}

/** The rows as drawn, top to bottom: what ↑ ↓ walk. */
export const flatHits = (groups: readonly SearchGroup[]): SearchHit[] => groups.flatMap((g) => g.hits);

/** What Enter opens with nothing highlighted: the first row. */
export const topHit = (groups: readonly SearchGroup[]): SearchHit | null => groups[0]?.hits[0] ?? null;

// ---- recent places --------------------------------------------------------------------------------

/** A remembered key as the row that opens it, or null when it no longer resolves (a desk or agent gone, junk). */
export function placeHit(key: string, src: SearchSources): SearchHit | null {
  const page = DESTINATIONS.find((p) => p.key === key);
  if (page) return pageHit(page);
  const [kind, rest] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  if (kind === "desk") {
    const d = src.desks.find((x) => x.scope === rest);
    return d && openable(d) ? deskHit(d, agentNamer(src)(d.agentId, d.agentName)) : null;
  }
  if (kind === "agent") {
    const a = src.agents.find((x) => x.id === rest);
    return a ? agentHit(a) : null;
  }
  return null;
}

/** The recent places as rows, the stale ones gone. */
export function recentPlaceHits(keys: readonly string[], src: SearchSources): SearchHit[] {
  return keys.map((k) => placeHit(k, src)).filter((h): h is SearchHit => h !== null);
}

/** The key a visit is remembered under: a desk by scope, a section by name (Preferences pages are remembered when opened from search). */
export function deskPlace(scope: string): string {
  return `desk:${scope}`;
}
export const sectionPlace = (segment: Exclude<Segment, "settings">): string => `page:${segment}`;
