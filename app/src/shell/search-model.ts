import type { AttentionItem } from "../../../core/attention/model.ts";
import { catchUpQueue } from "../../../core/attention/queue.ts";
import { isMainChat, scopeFor } from "../../../core/chat-scope.ts";

import {
  GROUP_MAX,
  WAITS,
  buildSearchIndex,
  groupHits,
  rankHits,
  timeOf,
  type HitGroup,
  type Indexed,
  type Lead,
  type SearchIndex as CoreIndex,
} from "../shared/search";
import { createRecents } from "../shared/recents";
import type { IconName } from "../shared/icons";
import { PAGES, PAGE_WORDS, pageTitle, type SettingsPage } from "../settings/pages";
import type { Segment } from "./keymap";
import { osWords } from "./os-words";
import type { ChatSummary } from "../../../core/frame-types.ts";
import { HORIZON_LABEL, type Goal } from "../../../core/goals.ts";
import type { LabelView } from "../../../core/labels.ts";

export const COVERAGE = "Searches chat titles, agents, labels, waiting items and pages — not message text.";

export function coverageLine({ commands, chat }: { commands: boolean; chat: boolean }): string {
  if (!commands && !chat) return COVERAGE;
  const kinds = ["chats", "agents", "labels", "waiting items", "pages", ...(commands ? ["commands"] : []), ...(chat ? ["this chat's models and modes"] : [])];
  return `Finds ${kinds.slice(0, -1).join(", ")} and ${kinds.at(-1) ?? ""}, not message text.`;
}

export type GroupId = "desks" | "goals" | "agents" | "labels" | "waiting" | "pages";
const GROUP_TITLE: Record<GroupId, string> = { desks: "Chats", goals: "Goals", agents: "Agents", labels: "Labels", waiting: "Waiting", pages: "Pages" };

export type SearchTarget =
  | { kind: "desk"; agentId: string; conversationId: string }
  | { kind: "goal"; goalId: string }
  | { kind: "agent"; agentId: string }
  | { kind: "label"; name: string }
  | { kind: "section"; segment: Exclude<Segment, "settings"> }
  | { kind: "preferences"; page: SettingsPage | null };

export interface SearchHit {
  key: string;
  place: string;
  group: GroupId;
  title: string;
  preview: string;
  target: SearchTarget;
  lead: Lead;
  dim: boolean;
}

export type SearchGroup = HitGroup<SearchHit, GroupId>;

export interface SearchSources {
  desks: ChatSummary[];
  agents: Array<{ id: string; name: string }>;
  items: AttentionItem[];
  labels?: readonly LabelView[] | null;
  goals?: readonly Goal[] | null;
}

interface Page {
  key: string;
  target: SearchTarget;
  icon: IconName;
  label: string;
  line: string;
  keywords: string[];
}

export const DESTINATIONS: readonly Page[] = [
  {
    key: "page:desk",
    target: { kind: "section", segment: "chats" },
    icon: "desk",
    label: "Chats",
    line: "The chat you were on",
    keywords: ["chats", "desks", "desk", "home"],
  },
  {
    key: "page:inbox",
    target: { kind: "section", segment: "flow" },
    icon: "inbox",
    label: "Flow",
    line: "What waits on you",
    keywords: ["inbox", "catch up", "waiting", "approvals"],
  },
  {
    key: "page:goals",
    target: { kind: "section", segment: "goals" },
    icon: "target",
    label: "Goals",
    line: "Short, medium, and long term goals",
    keywords: ["goals", "targets", "milestones", "habits", "woop"],
  },
  {
    key: "page:agents",
    target: { kind: "section", segment: "agents" },
    icon: "agents",
    label: "Agents",
    line: `Every agent on ${osWords().machine}`,
    keywords: ["dms", "people", "memory"],
  },
  {
    key: "page:learn",
    target: { kind: "section", segment: "learn" },
    icon: "learn",
    label: "Learn",
    line: "What your agents learned, to review",
    keywords: ["recall", "cards", "lessons", "review"],
  },
  { key: "prefs", target: { kind: "preferences", page: null }, icon: "settings", label: "Preferences", line: "Settings", keywords: ["settings"] },
  ...PAGES.map(({ id }): Page => ({
    key: `prefs:${id}`,
    target: { kind: "preferences", page: id },
    icon: "settings",
    label: pageTitle(id),
    line: "Preferences",
    keywords: PAGE_WORDS[id] ?? [],
  })),
];

export const PLACES_KEY = "loki.desktop.recentPlaces";
export const recentPlaces = createRecents({ key: PLACES_KEY, max: 8 });

type OpenableDesk = ChatSummary & { agent_id: string; conversation_id: string };
const openable = (d: ChatSummary): d is OpenableDesk => !!d.agent_id && !!d.conversation_id && d.status !== "deleted";

const deskTitle = (d: ChatSummary): string => d.title ?? (isMainChat(d.conversation_id) ? "Main chat" : d.status === "live" ? "New chat" : d.scope);

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
  target: { kind: "desk", agentId: d.agent_id, conversationId: d.conversation_id },
  lead: { icon: d.status === "live" ? "desk" : "archive" },
  dim: d.status !== "live",
});
const goalHit = (g: Goal): SearchHit => ({
  key: `goal:${g.id}`,
  place: `goal:${g.id}`,
  group: "goals",
  title: g.title,
  preview: HORIZON_LABEL[g.horizon],
  target: { kind: "goal", goalId: g.id },
  lead: { icon: "target" },
  dim: g.status !== "active" && g.status !== "suggested",
});
const agentHit = (a: { id: string; name: string }): SearchHit => ({
  key: `agent:${a.id}`,
  place: `agent:${a.id}`,
  group: "agents",
  title: a.name,
  preview: "Agent",
  target: { kind: "agent", agentId: a.id },
  lead: { agent: a },
  dim: false,
});
const labelHit = (l: LabelView): SearchHit => ({
  key: `label:${l.name}`,
  place: `label:${l.name}`,
  group: "labels",
  title: l.name,
  preview: `Label · ${l.chats} ${l.chats === 1 ? "chat" : "chats"}`,
  target: { kind: "label", name: l.name },
  lead: { icon: "filter" },
  dim: false,
});
const itemHit = (i: AttentionItem, agentName: string): SearchHit => ({
  key: `waiting:${i.agent_id}/${i.id}`,
  place: chatPlace(scopeFor(i.id, i.agent_id)),
  group: "waiting",
  title: i.title || "Untitled conversation",
  preview: [agentName, WAITS[i.status]].filter(Boolean).join(" · "),
  target: { kind: "desk", agentId: i.agent_id, conversationId: i.id },
  lead: { agent: { id: i.agent_id, name: agentName } },
  dim: false,
});
const pageHit = (p: Page): SearchHit => ({
  key: p.key,
  place: p.key,
  group: "pages",
  title: p.label,
  preview: p.line,
  target: p.target,
  lead: { icon: p.icon },
  dim: false,
});

export type SearchIndex = CoreIndex<SearchHit>;

export function buildIndex(src: SearchSources): SearchIndex {
  const name = agentNamer(src);
  const out: Array<Indexed<SearchHit>> = [];
  for (const d of src.desks)
    if (openable(d))
      out.push({ hit: deskHit(d, name(d.agent_id, d.agent_name)), fields: [deskTitle(d), name(d.agent_id, d.agent_name)], recency: timeOf(d.last_active) });
  for (const g of src.goals ?? [])
    if (g.status === "active" || g.status === "suggested")
      out.push({ hit: goalHit(g), fields: [g.title, HORIZON_LABEL[g.horizon], g.why ?? "", g.next_step ?? ""], recency: timeOf(g.updated_at) });
  for (const a of src.agents) out.push({ hit: agentHit(a), fields: [a.name], recency: 0 });
  for (const l of src.labels ?? []) out.push({ hit: labelHit(l), fields: [l.name, `label:${l.name}`], recency: 0 });
  for (const i of catchUpQueue(src.items)) {
    if (i.outside) continue;
    const n = name(i.agent_id, i.agent_name);
    out.push({ hit: itemHit(i, n), fields: [i.title ?? "", n], recency: timeOf(i.last_message_at) });
  }
  for (const p of DESTINATIONS) out.push({ hit: pageHit(p), fields: [p.label, ...p.keywords], recency: 0 });
  return buildSearchIndex(out);
}

export function search(idx: SearchIndex, raw: string, max = GROUP_MAX): SearchGroup[] {
  const hits = rankHits(idx, raw);
  const order = [...new Set(hits.map((h) => h.group))];
  return groupHits(hits, (h) => h.group, order, GROUP_TITLE, max);
}

export const flatHits = (groups: readonly SearchGroup[]): SearchHit[] => groups.flatMap((g) => g.hits);

export const topHit = (groups: readonly SearchGroup[]): SearchHit | null => groups[0]?.hits[0] ?? null;

export function placeHit(key: string, src: SearchSources): SearchHit | null {
  const page = DESTINATIONS.find((p) => p.key === key);
  if (page) return pageHit(page);
  const [kind, rest] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  if (kind === "desk") {
    const d = src.desks.find((x) => x.scope === rest);
    return d && openable(d) ? deskHit(d, agentNamer(src)(d.agent_id, d.agent_name)) : null;
  }
  if (kind === "goal") {
    const g = src.goals?.find((x) => x.id === rest);
    return g ? goalHit(g) : null;
  }
  if (kind === "agent") {
    const a = src.agents.find((x) => x.id === rest);
    return a ? agentHit(a) : null;
  }
  if (kind === "label") {
    const l = src.labels?.find((x) => x.name === rest);
    return l ? labelHit(l) : null;
  }
  return null;
}

export function recentPlaceHits(keys: readonly string[], src: SearchSources): SearchHit[] {
  return keys.map((k) => placeHit(k, src)).filter((h): h is SearchHit => h !== null);
}

export function chatPlace(scope: string): string {
  return `desk:${scope}`;
}
export const sectionPlace = (segment: Exclude<Segment, "settings">): string => `page:${segment}`;
