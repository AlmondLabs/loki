import { unviewed, type AttentionItem } from "../../../core/attention/model.ts";
import type { ChatSummary, MacIdentity } from "../../../core/frame-types.ts";
import { labelQuery } from "../../../core/labels.ts";
import { isMainChat } from "../../../core/chat-scope.ts";

export type MarkKind = "waits" | "failed" | "finished" | "running" | "archived" | "deleted" | "none";

export function deskMark(
  item: AttentionItem | undefined,
  status: ChatSummary["status"],
): { kind: MarkKind; color: string; border: string; title: string; pulse: boolean } {
  if (status === "deleted") return { kind: "deleted", color: "transparent", border: "var(--loki-negative)", title: "conversation deleted", pulse: false };
  if (status === "archived") return { kind: "archived", color: "transparent", border: "var(--loki-muted)", title: "archived", pulse: false };
  if (item) {
    if (item.status === "approval" || item.status === "question")
      return {
        kind: "waits",
        color: "var(--loki-attention)",
        border: "var(--loki-attention)",
        title: item.status === "approval" ? "needs approval" : "asked you",
        pulse: false,
      };
    if (item.status === "failed") return { kind: "failed", color: "var(--loki-negative)", border: "var(--loki-negative)", title: "failed", pulse: false };
    if (item.status === "done" && item.unread)
      return { kind: "finished", color: "transparent", border: "var(--loki-fg)", title: "finished, unread", pulse: false };
    if (item.status === "running") return { kind: "running", color: "transparent", border: "var(--loki-muted)", title: "running", pulse: true };
  }
  return { kind: "none", color: "transparent", border: "transparent", title: "", pulse: false };
}

export const canArchive = (d: ChatSummary): boolean => !!d.conversation_id && !isMainChat(d.conversation_id) && d.status !== "deleted";
export const canRename = (d: ChatSummary): boolean => !!d.conversation_id && !isMainChat(d.conversation_id) && d.status !== "deleted";

export const DESK_NAME_MAX = 80;

export function cleanDeskName(raw: string): string | null {
  const name = raw.replace(/\s+/g, " ").trim().slice(0, DESK_NAME_MAX).trimEnd();
  return name || null;
}
export const canLabel = (d: ChatSummary): boolean => !!d.agent_id && !!d.conversation_id && d.status !== "deleted";
export const canMove = (d: ChatSummary): boolean => !!d.agent_id && !!d.conversation_id && d.status !== "deleted";

export const canPin = (d: ChatSummary): boolean => !!d.agent_id && !!d.conversation_id && d.status === "live";

export interface RowState {
  kind: MarkKind;
  badge: number | null;
  badgeNoun?: string;
  unread: boolean;
  live: boolean;
  note?: string;
}

export function deskRowState(item: AttentionItem | undefined, d: Pick<ChatSummary, "status">): RowState {
  const mark = deskMark(item, d.status);
  const waits = mark.kind === "waits";
  const finished = mark.kind === "finished";
  const fresh = finished && !!item && unviewed(item);
  return {
    kind: mark.kind,
    badge: waits ? 1 : null,
    badgeNoun: waits ? mark.title : undefined,
    unread: waits || fresh,
    live: mark.kind === "running",
    note: fresh ? "new messages" : undefined,
  };
}

export function doneAction(item: AttentionItem | undefined | null): "done" | "undone" | null {
  if (!item || item.pendingApproval) return null;
  if (item.unread) return "done";
  return item.lastRole === "assistant" && !!item.last_message_at ? "undone" : null;
}

export interface SidebarRow extends RowState {
  desk: ChatSummary;
  main: boolean;
  current: boolean;
}

export interface SidebarSection {
  id: string;
  title: string;
  agentId: string | null;
  rows: SidebarRow[];
  waiting: number;
}

export interface SidebarModel {
  sections: SidebarSection[];
  archived: SidebarRow[];
  empty: boolean;
}

const byRecent = (a: ChatSummary, b: ChatSummary) => (b.last_active ?? "").localeCompare(a.last_active ?? "");

export function sidebarModel(
  desks: ChatSummary[],
  items: AttentionItem[],
  opts: { query?: string; current?: string; agents?: Array<{ id: string; name: string }> },
): SidebarModel {
  const query = labelQuery(opts.query ?? "");
  const q = query.text.toLowerCase();
  const filtering = q !== "" || query.labels.length > 0;
  const itemOf = new Map(items.map((i) => [`${i.agent_id}/${i.id}`, i]));
  const names = new Map((opts.agents ?? []).map((a) => [a.id, a.name]));
  const agentName = (d: ChatSummary) => (d.agent_id ? (names.get(d.agent_id) ?? d.agent_name) : d.agent_name) ?? (d.agent_id ? "Agent" : "Other chats");
  const matches = (d: ChatSummary) =>
    query.labels.every((l) => d.labels?.includes(l)) && (!q || (d.title ?? "").toLowerCase().includes(q) || agentName(d).toLowerCase().includes(q));
  const row = (d: ChatSummary): SidebarRow => ({
    desk: d,
    ...deskRowState(itemOf.get(`${d.agent_id}/${d.conversation_id}`), d),
    main: isMainChat(d.conversation_id),
    current: d.scope === opts.current,
  });

  const live = desks.filter((d) => d.status === "live" && d.scope !== "shared");
  const latest = new Map<string, string>();
  for (const d of live) {
    const k = d.agent_id ?? "",
      at = d.last_active ?? "";
    if (at >= (latest.get(k) ?? "")) latest.set(k, at);
  }
  const shown = live.filter(matches);
  const sections: SidebarSection[] = [];
  const pinned = shown.filter((d) => d.pinned).sort(byRecent);
  if (pinned.length) sections.push(section("pinned", "Pinned", null, pinned.map(row)));
  const groups = new Map<string, ChatSummary[]>();
  for (const d of shown) {
    if (d.pinned) continue;
    const k = d.agent_id ?? "";
    const group = groups.get(k);
    if (group) group.push(d);
    else groups.set(k, [d]);
  }
  const order = [...groups].sort(
    ([a, listA], [b, listB]) => (latest.get(b) ?? "").localeCompare(latest.get(a) ?? "") || agentName(listA[0]).localeCompare(agentName(listB[0])),
  );
  for (const [k, desksOfAgent] of order) {
    const list = desksOfAgent.sort((a, b) => Number(isMainChat(b.conversation_id)) - Number(isMainChat(a.conversation_id)) || byRecent(a, b));
    sections.push(section(`agent:${k}`, agentName(list[0]), k || null, list.map(row)));
  }
  const archived = desks.filter((d) => isArchived(d.status) && matches(d)).map(row);
  return { sections, archived, empty: filtering && sections.length === 0 && archived.length === 0 };
}

const isArchived = (status: ChatSummary["status"]) => status === "archived" || status === "deleted";

function section(id: string, title: string, agentId: string | null, rows: SidebarRow[]): SidebarSection {
  return { id, title, agentId, rows, waiting: rows.filter((r) => r.kind === "waits").length };
}

export const ALL_CHATS = "all";
export const PINNED_CHATS = "pinned";
export const ARCHIVED_CHATS = "archived";
export const agentSource = (agentId: string | null | undefined): string => `agent:${agentId ?? ""}`;

export interface ChatSource {
  id: string;
  title: string;
  agentId: string | null;
  waiting: number;
}

export function chatSourcesFrom(m: SidebarModel, agents: Array<{ id: string; name: string }> = []): ChatSource[] {
  const listed = m.sections.filter((s) => s.id !== PINNED_CHATS);
  const has = new Set(listed.map((s) => s.agentId));
  const rest = agents.filter((a) => !has.has(a.id)).sort((a, b) => a.name.localeCompare(b.name));
  return [
    { id: PINNED_CHATS, title: "Pinned", agentId: null, waiting: m.sections.find((s) => s.id === PINNED_CHATS)?.waiting ?? 0 },
    ...listed.map((s) => ({ id: s.id, title: s.title, agentId: s.agentId, waiting: s.waiting })),
    ...rest.map((a) => ({ id: agentSource(a.id), title: a.name, agentId: a.id, waiting: 0 })),
    { id: ARCHIVED_CHATS, title: "Archived", agentId: null, waiting: 0 },
  ];
}

export function chatSources(desks: ChatSummary[], items: AttentionItem[], agents: Array<{ id: string; name: string }> = []): ChatSource[] {
  return chatSourcesFrom(sidebarModel(desks, items, { agents }), agents);
}

export interface SourceRow extends SidebarRow {
  section?: string;
}

export function sourceRowsFrom(m: SidebarModel, source: string): SourceRow[] {
  if (source === ARCHIVED_CHATS) return m.archived;
  if (source === ALL_CHATS) return m.sections.flatMap((s) => s.rows.map((r) => ({ ...r, section: s.title })));
  return m.sections.find((s) => s.id === source)?.rows ?? [];
}

export function sourceRows(
  desks: ChatSummary[],
  items: AttentionItem[],
  opts: { source: string; query?: string; agents?: Array<{ id: string; name: string }> },
): SourceRow[] {
  return sourceRowsFrom(sidebarModel(desks, items, { query: opts.query, agents: opts.agents }), opts.source);
}

export const CHAT_STATES = ["all", "waiting", "unread", "working"] as const;
export type ChatState = (typeof CHAT_STATES)[number];

export function rowInState(row: Pick<SidebarRow, "kind" | "unread" | "live">, state: ChatState): boolean {
  if (state === "waiting") return row.kind === "waits";
  if (state === "unread") return row.unread;
  if (state === "working") return row.live;
  return true;
}

export function stateRows<R extends Pick<SidebarRow, "kind" | "unread" | "live">>(rows: readonly R[], state: ChatState): R[] {
  return rows.filter((r) => rowInState(r, state));
}

type Placed = Pick<ChatSummary, "status" | "pinned" | "agent_id">;

export function sourceHolds(source: string, d: Placed): boolean {
  if (source === ARCHIVED_CHATS) return isArchived(d.status);
  if (d.status !== "live") return false;
  if (source === ALL_CHATS) return true;
  if (source === PINNED_CHATS) return !!d.pinned;
  return !d.pinned && source === agentSource(d.agent_id);
}

export function sourceFor(d: Placed): string {
  return isArchived(d.status) ? ARCHIVED_CHATS : ALL_CHATS;
}

export function openIn(
  target: { scope: string; agent_id: string | null },
  at: { source: string; query: string },
  desks: ChatSummary[],
  agents?: Array<{ id: string; name: string }>,
): { source: string; query: string } {
  const d = desks.find((x) => x.scope === target.scope) ?? { status: "live" as const, pinned: false, agent_id: target.agent_id };
  const source = sourceHolds(at.source, d) ? at.source : sourceFor(d);
  const shows = !at.query.trim() || sourceRows(desks, [], { source, query: at.query, agents }).some((r) => r.desk.scope === target.scope);
  return { source, query: shows ? at.query : "" };
}

export function offscreenWaits(
  rows: Array<{ id: string; top: number; bottom: number }>,
  view: { top: number; bottom: number },
): { up: string | null; down: string | null } {
  let up: { id: string; top: number } | null = null;
  let down: { id: string; top: number } | null = null;
  for (const r of rows) {
    if (r.bottom <= view.top && (!up || r.top > up.top)) up = r;
    else if (r.top >= view.bottom && (!down || r.top < down.top)) down = r;
  }
  return { up: up?.id ?? null, down: down?.id ?? null };
}

export const SIDEBAR_KEY = "loki.desktop.sidebar";

export interface SidebarPref {
  collapsed: string[];
}

export function parseSidebar(raw: string | null): SidebarPref {
  if (!raw) return { collapsed: [] };
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof SidebarPref, unknown>>;
    return { collapsed: Array.isArray(v.collapsed) ? v.collapsed.filter((x): x is string => typeof x === "string") : [] };
  } catch {
    return { collapsed: [] };
  }
}

type Store = Pick<Storage, "getItem" | "setItem">;

export function loadSidebar(store: Store): SidebarPref {
  try {
    return parseSidebar(store.getItem(SIDEBAR_KEY));
  } catch {
    return { collapsed: [] };
  }
}

export function saveSidebar(store: Store, pref: SidebarPref): void {
  try {
    store.setItem(SIDEBAR_KEY, JSON.stringify(pref));
  } catch {}
}

export function toggleFold(pref: SidebarPref, id: string): SidebarPref {
  return { ...pref, collapsed: pref.collapsed.includes(id) ? pref.collapsed.filter((c) => c !== id) : [...pref.collapsed, id] };
}

export interface MoveTarget {
  mac_id: string;
  name: string;
  reachable: boolean;
}

export function moveTargets(
  d: Pick<ChatSummary, "agent_id" | "conversation_id" | "home" | "reachable">,
  macs: { me: MacIdentity; peers: Array<MacIdentity & { reachable: boolean }> } | null,
): MoveTarget[] {
  if (!macs?.peers.length || !d.agent_id || !d.conversation_id || isMainChat(d.conversation_id) || d.reachable === false) return [];
  const all = [
    { mac_id: macs.me.mac_id, name: macs.me.name, reachable: true },
    ...macs.peers.map((p) => ({ mac_id: p.mac_id, name: p.name, reachable: p.reachable })),
  ];
  const lives = d.home ?? macs.me.mac_id;
  return all.filter((m) => m.mac_id !== lives);
}

export function homeMark(
  row: { home?: string; home_name?: string; reachable?: boolean },
  agentHome: string | null | undefined,
  here: string | undefined,
  machine: string,
): { kind: "away" | "asleep"; note: string } | null {
  const asleep = row.reachable === false;
  const lives = row.home ?? here;
  if (!asleep && agentHome && lives === agentHome) return null;
  const name = row.home ? (row.home_name ?? "another Mac") : agentHome && here && lives === here ? machine : null;
  if (name === null) return null;
  if (asleep) return { kind: "asleep", note: `${name} is asleep or off: this chat waits for it` };
  return { kind: "away", note: agentHome ? `lives on ${name}, away from its agent's Mac` : `lives on ${name}` };
}
