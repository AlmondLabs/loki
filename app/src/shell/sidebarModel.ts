import type { AttentionItem } from "../../../core/attention/model.ts";
import type { DeskSummary } from "../desk/useDesk";

/**
 * The desk sidebar's model (plan 013 U4), pure so its rules are tested without a window: Pinned, then one
 * section per agent ordered by the agent's most recent activity, each live desk once (a pinned desk only
 * under Pinned), the agent's main chat first in its section; the filter by desk title or agent name; the
 * marks each row carries; the archive below; the "needs you" pills; and what is kept across restarts.
 */

export type MarkKind = "waits" | "failed" | "finished" | "running" | "archived" | "deleted" | "none";

/**
 * The dot before a desk, as colours and words: the red attention dot when it waits on you (an approval or a
 * question), red ink when it failed, an fg ring when it finished unread (its row goes bold, like Slack's unread), a faint pulsing ring while
 * it runs; archived and deleted desks get a muted or oxblood ring. Pure, so the phone shares it.
 */
export function deskMark(item: AttentionItem | undefined, status: DeskSummary["status"]): { kind: MarkKind; color: string; border: string; title: string; pulse: boolean } {
  if (status === "deleted") return { kind: "deleted", color: "transparent", border: "var(--loki-negative)", title: "conversation deleted", pulse: false };
  if (status === "archived") return { kind: "archived", color: "transparent", border: "var(--loki-muted)", title: "archived", pulse: false };
  if (item) {
    if (item.status === "approval" || item.status === "question") return { kind: "waits", color: "var(--loki-attention)", border: "var(--loki-attention)", title: item.status === "approval" ? "needs approval" : "asked you", pulse: false };
    if (item.status === "failed") return { kind: "failed", color: "var(--loki-negative)", border: "var(--loki-negative)", title: "failed", pulse: false };
    if (item.status === "done" && item.unread && !item.snooze) return { kind: "finished", color: "transparent", border: "var(--loki-fg)", title: "finished, unread", pulse: false };
    if (item.status === "running") return { kind: "running", color: "transparent", border: "var(--loki-muted)", title: "running", pulse: true };
  }
  return { kind: "none", color: "transparent", border: "transparent", title: "", pulse: false };
}

/** A conversation can be archived (or restored) unless it is the agent's main chat or already deleted. */
export const canArchive = (d: DeskSummary): boolean => !!d.conversationId && d.conversationId !== "default" && d.status !== "deleted";
/** A live desk with an agent and a conversation can be pinned. */
export const canPin = (d: DeskSummary): boolean => !!d.agentId && !!d.conversationId && d.status === "live";

/** What a row shows: the red badge (one per waiting conversation), the bold title, the live dot. */
export interface RowState {
  kind: MarkKind;
  badge: number | null;
  badgeNoun?: string;
  unread: boolean;
  live: boolean;
}

export function deskRowState(item: AttentionItem | undefined, d: DeskSummary): RowState {
  const mark = deskMark(item, d.status);
  const waits = mark.kind === "waits";
  // Waiting is news too, so its title goes bold beside the badge, as the tree's did.
  return { kind: mark.kind, badge: waits ? 1 : null, badgeNoun: waits ? mark.title : undefined, unread: waits || mark.kind === "finished", live: mark.kind === "running" };
}

export interface SidebarRow extends RowState {
  desk: DeskSummary;
  /** The agent's main chat (conversation "default"). */
  main: boolean;
  current: boolean;
}

export interface SidebarSection {
  /** "pinned" or "agent:<agentId>" — the key a fold is kept under. */
  id: string;
  title: string;
  /** The section's agent: its "new desk" action starts one with them. Null for Pinned and desks with no agent. */
  agentId: string | null;
  rows: SidebarRow[];
  /** Rows that wait on you, for the folded section's count. */
  waiting: number;
}

export interface SidebarModel {
  sections: SidebarSection[];
  /** Archived and deleted desks, in the mod's order, behind the Archived entry. */
  archived: SidebarRow[];
  /** A filter matched nothing at all: the empty state with its clear action. */
  empty: boolean;
}

const byRecent = (a: DeskSummary, b: DeskSummary) => (b.lastActive ?? "").localeCompare(a.lastActive ?? "");

export function sidebarModel(desks: DeskSummary[], items: AttentionItem[], opts: { query?: string; current?: string; agents?: Array<{ id: string; name: string }> }): SidebarModel {
  const q = (opts.query ?? "").trim().toLowerCase();
  const itemOf = new Map(items.map((i) => [`${i.agentId}/${i.id}`, i]));
  const names = new Map((opts.agents ?? []).map((a) => [a.id, a.name]));
  const agentName = (d: DeskSummary) => (d.agentId ? (names.get(d.agentId) ?? d.agentName) : d.agentName) ?? (d.agentId ? "Agent" : "Other desks");
  const matches = (d: DeskSummary) => !q || (d.title ?? "").toLowerCase().includes(q) || agentName(d).toLowerCase().includes(q);
  const row = (d: DeskSummary): SidebarRow => ({ desk: d, ...deskRowState(itemOf.get(`${d.agentId}/${d.conversationId}`), d), main: d.conversationId === "default", current: d.scope === opts.current });

  const live = desks.filter((d) => d.status === "live" && d.scope !== "shared");
  // An agent's place: its most recent activity on any live desk, pinned ones included, before the filter.
  const latest = new Map<string, string>();
  for (const d of live) {
    const k = d.agentId ?? "", at = d.lastActive ?? "";
    if (at >= (latest.get(k) ?? "")) latest.set(k, at);
  }
  const shown = live.filter(matches);
  const sections: SidebarSection[] = [];
  const pinned = shown.filter((d) => d.pinned).sort(byRecent);
  if (pinned.length) sections.push(section("pinned", "Pinned", null, pinned.map(row)));
  const groups = new Map<string, DeskSummary[]>();
  for (const d of shown) if (!d.pinned) groups.set(d.agentId ?? "", [...(groups.get(d.agentId ?? "") ?? []), d]);
  const order = [...groups.keys()].sort((a, b) => (latest.get(b) ?? "").localeCompare(latest.get(a) ?? "") || agentName(groups.get(a)![0]).localeCompare(agentName(groups.get(b)![0])));
  for (const k of order) {
    const list = groups.get(k)!.sort((a, b) => Number(b.conversationId === "default") - Number(a.conversationId === "default") || byRecent(a, b));
    sections.push(section(`agent:${k}`, agentName(list[0]), k || null, list.map(row)));
  }
  const archived = desks.filter((d) => d.status !== "live" && matches(d)).map(row);
  return { sections, archived, empty: !!q && sections.length === 0 && archived.length === 0 };
}

function section(id: string, title: string, agentId: string | null, rows: SidebarRow[]): SidebarSection {
  return { id, title, agentId, rows, waiting: rows.filter((r) => r.kind === "waits").length };
}

/**
 * The "needs you" pills, Slack's "Unread mentions": given where each waiting row sits (in the scroll
 * content's coordinates) and the visible band, the nearest one wholly above the band and the nearest one
 * wholly below it. A row partly in view counts as seen.
 */
export function offscreenWaits(rows: Array<{ id: string; top: number; bottom: number }>, view: { top: number; bottom: number }): { up: string | null; down: string | null } {
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
  /** Section ids folded shut. */
  collapsed: string[];
  /** The Archived entry starts folded. */
  archivedOpen: boolean;
  /** The list's scrollTop. */
  scroll: number;
}

const FRESH: SidebarPref = { collapsed: [], archivedOpen: false, scroll: 0 };

export function parseSidebar(raw: string | null): SidebarPref {
  if (!raw) return { ...FRESH };
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof SidebarPref, unknown>>;
    return {
      collapsed: Array.isArray(v.collapsed) ? v.collapsed.filter((x): x is string => typeof x === "string") : [],
      archivedOpen: v.archivedOpen === true,
      scroll: typeof v.scroll === "number" && Number.isFinite(v.scroll) && v.scroll > 0 ? Math.round(v.scroll) : 0,
    };
  } catch {
    return { ...FRESH };
  }
}

type Store = Pick<Storage, "getItem" | "setItem">;

export function loadSidebar(store: Store): SidebarPref {
  try {
    return parseSidebar(store.getItem(SIDEBAR_KEY));
  } catch {
    return { ...FRESH };
  }
}

export function saveSidebar(store: Store, pref: SidebarPref): void {
  try {
    store.setItem(SIDEBAR_KEY, JSON.stringify(pref));
  } catch {
    // a blocked store only costs the folds and the scroll across restarts
  }
}

export function toggleFold(pref: SidebarPref, id: string): SidebarPref {
  return { ...pref, collapsed: pref.collapsed.includes(id) ? pref.collapsed.filter((c) => c !== id) : [...pref.collapsed, id] };
}
