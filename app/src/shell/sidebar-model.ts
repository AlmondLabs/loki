import { unviewed, type AttentionItem } from "../../../core/attention/model.ts";
import type { DeskSummary, MacIdentity } from "../../../core/frame-types.ts";
import { labelQuery } from "../../../core/labels.ts";

/**
 * The desk sidebar's model (plan 013 U4), pure so its rules are tested without a window: Pinned, then one
 * section per agent ordered by the agent's most recent activity, each live desk once (a pinned desk only
 * under Pinned), the agent's main chat first in its section; the filter by desk title or agent name; the
 * marks each row carries; the archive below; the "needs you" pills; and what is kept across restarts.
 */

/** The mark before a chat: waiting on you, failed, finished unread, running, archived, deleted, or none. */
export type MarkKind = "waits" | "failed" | "finished" | "running" | "archived" | "deleted" | "none";

/**
 * The dot before a desk, as colours and words: the red attention dot when it waits on you (an approval or a
 * question), red ink when it failed, an fg ring when it finished unread (its row goes bold, like Slack's unread), a faint pulsing ring while
 * it runs; archived and deleted desks get a muted or oxblood ring. Pure, so the phone shares it.
 */
export function deskMark(
  item: AttentionItem | undefined,
  status: DeskSummary["status"],
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

/** A conversation can be archived (or restored) unless it is the agent's main chat or already deleted. */
export const canArchive = (d: DeskSummary): boolean => !!d.conversation_id && d.conversation_id !== "default" && d.status !== "deleted";
/**
 * A desk with its own conversation can be renamed, archived or not: the name is the chat's title. The main chat is
 * called after its agent (it has no summary to set) and a deleted desk has no conversation left to write to.
 */
export const canRename = (d: DeskSummary): boolean => !!d.conversation_id && d.conversation_id !== "default" && d.status !== "deleted";

/** Longest desk name: Slack's channel-name cap; past it a name stops fitting the sidebar row, the header and ⌘K anyway. */
export const DESK_NAME_MAX = 80;

/** A typed or pasted name as it is saved: whitespace runs (a pasted newline) made one space, trimmed, capped. Blank is no name (null). */
export function cleanDeskName(raw: string): string | null {
  const name = raw.replace(/\s+/g, " ").trim().slice(0, DESK_NAME_MAX).trimEnd();
  return name || null;
}
/** A desk with an agent and a conversation, not deleted, can carry labels (plan 022); a main chat can too. */
export const canLabel = (d: DeskSummary): boolean => !!d.agent_id && !!d.conversation_id && d.status !== "deleted";
/** A desk with an agent and a conversation, not deleted, can move to another folder (the daemon keeps it per chat). */
export const canMove = (d: DeskSummary): boolean => !!d.agent_id && !!d.conversation_id && d.status !== "deleted";

/** A live desk with an agent and a conversation can be pinned. */
export const canPin = (d: DeskSummary): boolean => !!d.agent_id && !!d.conversation_id && d.status === "live";

/**
 * What a row shows: the red badge (one per waiting conversation), the bold title, the live dot, and for a
 * finished desk not looked at since, its ring with the words for it. Bold + ring: new since you last looked;
 * neither: looked at. Done is the Inbox's, which still holds a chat you looked at until you clear it there.
 */
export interface RowState {
  kind: MarkKind;
  badge: number | null;
  badgeNoun?: string;
  unread: boolean;
  live: boolean;
  /** A finished desk's reading, in words, while it has news you have not looked at: "new messages". */
  note?: string;
}

/** What a chat's row shows, from its Inbox item and its status (see `RowState`). */
export function deskRowState(item: AttentionItem | undefined, d: Pick<DeskSummary, "status">): RowState {
  const mark = deskMark(item, d.status);
  const waits = mark.kind === "waits";
  const finished = mark.kind === "finished";
  // A look clears a finished desk's row, bold and ring (the Inbox keeps it until it is done there); waiting is news
  // until you act, so it stays bold beside its badge.
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

/**
 * Done, by hand: "done" offers Mark as done (the Inbox's clear, seen_mark) while the conversation is unread;
 * "undone" offers Mark as not done (the Inbox's undo, seen_unmark) once it is done and the last word was the
 * agent's (with yours last there is nothing to be not done with). An approval clears only by its decision.
 */
export function doneAction(item: AttentionItem | undefined | null): "done" | "undone" | null {
  if (!item || item.pendingApproval) return null;
  if (item.unread) return "done";
  return item.lastRole === "assistant" && !!item.last_message_at ? "undone" : null;
}

/** One row of the Chats sidebar: its chat, its marks, whether it is the agent's main chat, and whether it is the one on show. */
export interface SidebarRow extends RowState {
  desk: DeskSummary;
  /** The agent's main chat (conversation "default"). */
  main: boolean;
  current: boolean;
}

/** One section of the Chats sidebar: Pinned, or one agent's chats. */
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

/** The Chats sidebar as drawn: its sections, the archived chats, and whether a filter matched nothing. */
export interface SidebarModel {
  sections: SidebarSection[];
  /** Archived and deleted desks, in the mod's order, behind the Archived entry. */
  archived: SidebarRow[];
  /** A filter matched nothing at all: the empty state with its clear action. */
  empty: boolean;
}

const byRecent = (a: DeskSummary, b: DeskSummary) => (b.last_active ?? "").localeCompare(a.last_active ?? "");

/** The Chats sidebar's model, by the rules above, with `opts.query` filtering by chat title or agent name and `opts.current` marking the chat on show. */
export function sidebarModel(
  desks: DeskSummary[],
  items: AttentionItem[],
  opts: { query?: string; current?: string; agents?: Array<{ id: string; name: string }> },
): SidebarModel {
  // `label:` terms keep the chats with every label named; the words left match titles and agents (plan 022, R4).
  const query = labelQuery(opts.query ?? "");
  const q = query.text.toLowerCase();
  const filtering = q !== "" || query.labels.length > 0;
  const itemOf = new Map(items.map((i) => [`${i.agent_id}/${i.id}`, i]));
  const names = new Map((opts.agents ?? []).map((a) => [a.id, a.name]));
  const agentName = (d: DeskSummary) => (d.agent_id ? (names.get(d.agent_id) ?? d.agent_name) : d.agent_name) ?? (d.agent_id ? "Agent" : "Other chats");
  const matches = (d: DeskSummary) =>
    query.labels.every((l) => d.labels?.includes(l)) && (!q || (d.title ?? "").toLowerCase().includes(q) || agentName(d).toLowerCase().includes(q));
  const row = (d: DeskSummary): SidebarRow => ({
    desk: d,
    ...deskRowState(itemOf.get(`${d.agent_id}/${d.conversation_id}`), d),
    main: d.conversation_id === "default",
    current: d.scope === opts.current,
  });

  const live = desks.filter((d) => d.status === "live" && d.scope !== "shared");
  // An agent's place: its most recent activity on any live desk, pinned ones included, before the filter.
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
  const groups = new Map<string, DeskSummary[]>();
  for (const d of shown) if (!d.pinned) groups.set(d.agent_id ?? "", [...(groups.get(d.agent_id ?? "") ?? []), d]);
  const order = [...groups].sort(
    ([a, listA], [b, listB]) => (latest.get(b) ?? "").localeCompare(latest.get(a) ?? "") || agentName(listA[0]).localeCompare(agentName(listB[0])),
  );
  for (const [k, desksOfAgent] of order) {
    const list = desksOfAgent.sort((a, b) => Number(b.conversation_id === "default") - Number(a.conversation_id === "default") || byRecent(a, b));
    sections.push(section(`agent:${k}`, agentName(list[0]), k || null, list.map(row)));
  }
  const archived = desks.filter((d) => d.status !== "live" && matches(d)).map(row);
  return { sections, archived, empty: filtering && sections.length === 0 && archived.length === 0 };
}

function section(id: string, title: string, agentId: string | null, rows: SidebarRow[]): SidebarSection {
  return { id, title, agentId, rows, waiting: rows.filter((r) => r.kind === "waits").length };
}

/**
 * The "needs you" pills, Slack's "Unread mentions": given where each waiting row sits (in the scroll
 * content's coordinates) and the visible band, the nearest one wholly above the band and the nearest one
 * wholly below it. A row partly in view counts as seen.
 */
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

/** The localStorage key the sidebar's folds and scroll are kept under. */
export const SIDEBAR_KEY = "loki.desktop.sidebar";

/** The sidebar as the person left it: folded sections, the Archived entry, and the scroll. */
export interface SidebarPref {
  /** Section ids folded shut. */
  collapsed: string[];
  /** The Archived entry is open; it starts folded. */
  archivedOpen: boolean;
  /** The list's scrollTop. */
  scroll: number;
}

const FRESH: SidebarPref = { collapsed: [], archivedOpen: false, scroll: 0 };

/** Stored sidebar settings read back; anything missing, malformed or out of range is the fresh default. */
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

/** The sidebar as saved in `store`; the fresh default when it cannot be read. */
export function loadSidebar(store: Store): SidebarPref {
  try {
    return parseSidebar(store.getItem(SIDEBAR_KEY));
  } catch {
    return { ...FRESH };
  }
}

/** Save the sidebar to `store`; a blocked store saves nothing and does not throw. */
export function saveSidebar(store: Store, pref: SidebarPref): void {
  try {
    store.setItem(SIDEBAR_KEY, JSON.stringify(pref));
  } catch {
    // a blocked store only costs the folds and the scroll across restarts
  }
}

/** The settings with one section's fold flipped. */
export function toggleFold(pref: SidebarPref, id: string): SidebarPref {
  return { ...pref, collapsed: pref.collapsed.includes(id) ? pref.collapsed.filter((c) => c !== id) : [...pref.collapsed, id] };
}

/** A Mac a chat can move to, from its row's menu (plan 023, addendum A1). */
export interface MoveTarget {
  mac_id: string;
  name: string;
  /** In reach now: a Mac asleep or off is offered, but greyed. */
  reachable: boolean;
}

/**
 * Where a chat can move: every Mac but the one it lives on, this Mac first. None for a chat whose Mac is out of reach,
 * a row that is not a chat, or an agent's main chat, which there is one of and which lives with its agent: it moves
 * when the agent's home does. None until another Mac is paired.
 */
export function moveTargets(
  d: Pick<DeskSummary, "agent_id" | "conversation_id" | "home" | "reachable">,
  macs: { me: MacIdentity; peers: Array<MacIdentity & { reachable: boolean }> } | null,
): MoveTarget[] {
  if (!macs?.peers.length || !d.agent_id || !d.conversation_id || d.conversation_id === "default" || d.reachable === false) return [];
  const all = [
    { mac_id: macs.me.mac_id, name: macs.me.name, reachable: true },
    ...macs.peers.map((p) => ({ mac_id: p.mac_id, name: p.name, reachable: p.reachable })),
  ];
  const lives = d.home ?? macs.me.mac_id;
  return all.filter((m) => m.mac_id !== lives);
}

/**
 * The location mark a chat's row carries (plan 023): none for a chat on its agent's Mac in reach, which its section
 * names; "away" for a chat living elsewhere; "asleep" while its Mac is out of reach. Without `agentHome` (no Mac
 * paired, or the switcher's flat list), every chat on another Mac is marked. `machine` names this Mac. The note is
 * the mark's tooltip: where the chat lives and why that is marked.
 */
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
