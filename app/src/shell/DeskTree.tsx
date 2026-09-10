import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Chip, Dot, Field, IconButton, Sheet } from "../components";
import type { Scope } from "../../../packages/core/src/desk-core.ts";
import type { AttentionItem } from "../../../packages/core/src/attention/model.ts";
import type { DeskSummary } from "../desk/useDesk";
import { AgentChip, AgentFace } from "../desk/AgentChip";
import { avatarUrl } from "../desk/env";

export const TREE_WIDTH = 560;

type Row = { kind: "desk"; desk: DeskSummary } | { kind: "new"; agentId: string | null; name: string };

/** One chip per agent: the agents the server lists, plus any agent only the desks know, with its live desk count. */
export function agentChips(agents: Array<{ id: string; name: string }>, desks: DeskSummary[]): Array<{ id: string; name: string | null; count: number }> {
  const byId = new Map<string, { id: string; name: string | null; count: number }>();
  for (const a of agents) byId.set(a.id, { id: a.id, name: a.name, count: 0 });
  for (const d of desks) {
    if (d.status !== "live" || !d.agentId) continue;
    if (!byId.has(d.agentId)) byId.set(d.agentId, { id: d.agentId, name: d.agentName, count: 0 });
    byId.get(d.agentId)!.count++;
  }
  return [...byId.values()];
}

/** The filter: one agent (or null for all) and a lowercased query against title, scope and agent name. */
export function deskMatches(d: DeskSummary, agentFilter: string | null, q: string): boolean {
  return (!agentFilter || d.agentId === agentFilter) && (!q || (d.title ?? "").toLowerCase().includes(q) || d.scope.toLowerCase().includes(q) || (d.agentName ?? "").toLowerCase().includes(q));
}

/** The tree's main list: live desks (the shared sheet aside), pinned first, then by recency. */
export function liveDesks(desks: DeskSummary[], agentFilter: string | null, q: string): DeskSummary[] {
  return desks.filter((d) => d.status === "live" && d.scope !== "shared" && deskMatches(d, agentFilter, q)).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (b.lastActive ?? "").localeCompare(a.lastActive ?? ""));
}

export type SectionId = "waiting" | "pinned" | "recent" | "rest";
export interface Section {
  id: SectionId;
  label: string;
  desks: DeskSummary[];
}

/**
 * The switcher's order when nothing is typed. Waiting on you first (an approval or a question — the
 * brass dots), then pinned, then the desks you visited most recently in the order you visited them,
 * then everything else by last message. Every desk appears once. With a query the list is flat and
 * liveDesks() decides; sections would only hide matches.
 */
export function sectionDesks(desks: DeskSummary[], agentFilter: string | null, items: AttentionItem[], visited: string[]): Section[] {
  const live = liveDesks(desks, agentFilter, "");
  const waits = new Set(items.filter((i) => i.status === "approval" || i.status === "question").map((i) => `${i.agentId}/${i.id}`));
  const placed = new Set<string>();
  const take = (pick: (d: DeskSummary) => boolean, list: DeskSummary[] = live): DeskSummary[] => {
    const out: DeskSummary[] = [];
    for (const d of list) {
      if (placed.has(d.scope) || !pick(d)) continue;
      placed.add(d.scope);
      out.push(d);
    }
    return out;
  };
  const waiting = take((d) => waits.has(`${d.agentId}/${d.conversationId}`));
  const pinned = take((d) => !!d.pinned);
  const byScope = new Map(live.map((d) => [d.scope, d]));
  const recent = take(() => true, [...new Set(visited)].map((sc) => byScope.get(sc)).filter((d): d is DeskSummary => !!d && !placed.has(d.scope)).slice(0, 8));
  const rest = take(() => true);
  const sections: Section[] = [
    { id: "waiting", label: "waiting on you", desks: waiting },
    { id: "pinned", label: "pinned", desks: pinned },
    { id: "recent", label: "recent", desks: recent },
    { id: "rest", label: recent.length || pinned.length || waiting.length ? "everything else" : "desks", desks: rest },
  ];
  return sections.filter((sec) => sec.desks.length > 0);
}

/**
 * Where the highlight starts: the desk you were on before this one, so ⌘K then ↵ goes back; else the
 * current desk; else the top. `visited` is most recent first and its head is the current desk.
 */
export function initialIndex(rowScopes: Array<string | null>, visited: string[], current: string): number {
  const previous = visited.find((sc) => sc !== current);
  const back = previous ? rowScopes.indexOf(previous) : -1;
  if (back >= 0) return back;
  return Math.max(0, rowScopes.indexOf(current));
}

/** The folded group at the bottom: archived and deleted, in the mod's order. */
export function archivedDesks(desks: DeskSummary[], agentFilter: string | null, q: string): DeskSummary[] {
  return desks.filter((d) => d.status !== "live" && deskMatches(d, agentFilter, q));
}

export type MarkKind = "waits" | "failed" | "finished" | "running" | "archived" | "deleted" | "none";

/**
 * The dot before a desk, as colours and words: brass filled when it waits on you (an approval or a
 * question), oxblood when it failed, a brass ring when it finished unread, a faint pulsing ring while
 * it runs; archived and deleted desks get a muted or oxblood ring. Pure, so the phone shares it.
 */
export function deskMark(item: AttentionItem | undefined, status: DeskSummary["status"]): { kind: MarkKind; color: string; border: string; title: string; pulse: boolean } {
  if (status === "deleted") return { kind: "deleted", color: "transparent", border: "var(--loki-negative)", title: "conversation deleted", pulse: false };
  if (status === "archived") return { kind: "archived", color: "transparent", border: "var(--loki-muted)", title: "archived", pulse: false };
  if (item) {
    if (item.status === "approval" || item.status === "question") return { kind: "waits", color: "var(--loki-accent)", border: "var(--loki-accent)", title: item.status === "approval" ? "needs approval" : "asked you", pulse: false };
    if (item.status === "failed") return { kind: "failed", color: "var(--loki-negative)", border: "var(--loki-negative)", title: "failed", pulse: false };
    if (item.status === "done" && item.unread && !item.snooze) return { kind: "finished", color: "transparent", border: "var(--loki-accent)", title: "finished, unread", pulse: false };
    if (item.status === "running") return { kind: "running", color: "transparent", border: "var(--loki-muted)", title: "running", pulse: true };
  }
  return { kind: "none", color: "transparent", border: "transparent", title: "", pulse: false };
}

const NO_VISITS: string[] = [];

/**
 * The desks tree, which is also the quick switcher. Nothing typed: sections — waiting on you, pinned,
 * recent (in the order you visited), everything else — and the highlight starts on the desk you were on
 * before this one, so ⌘K ↵ goes back. Type to filter into one flat list. ↑↓ move, ↵ open, ⇧↵ open with
 * the chat focused, Tab / ⇧Tab cycle the agent chips, ⌘P pin, ⌘E archive, esc close. Archived and
 * deleted conversations sit under a folded "archive" group at the bottom. Each desk carries the same
 * attention mark the inbox gives it.
 */
export function DeskTree({ open, visited = NO_VISITS, ...props }: TreeProps & { open: boolean }) {
  /** The archive group's fold; it outlives the sheet, unlike the filter, so it stays with the wrapper. */
  const [showArchive, setShowArchive] = useState(false);
  // The sheet mounts on ⌘K with a blank filter and the highlight on the last desk, and goes away with it.
  if (!open) return null;
  return <TreeSheet {...props} visited={visited} showArchive={showArchive} onToggleArchive={() => setShowArchive((v) => !v)} />;
}

interface TreeProps {
  onClose: () => void;
  desks: DeskSummary[];
  /** Agents the app-server knows; an agent with no desk yet still gets a chip. */
  agents: Array<{ id: string; name: string }>;
  items: AttentionItem[];
  current: Scope;
  onSwitch: (scope: Scope) => void;
  /** Start a new desk for this agent (null: pick in the sheet); `name` when typed into the filter. */
  onNew?: (agentId: string | null, name: string) => void;
  /** Picker mode: a heading above the filter, and choosing a desk calls this instead of switching to it. */
  heading?: string | null;
  onPickDesk?: (desk: DeskSummary) => void;
  /** Pin / unpin and archive / restore a desk's conversation (hover buttons, ⌘P and ⌘E while filtering). */
  onPin?: (desk: DeskSummary, pinned: boolean) => void;
  onArchive?: (desk: DeskSummary, archived: boolean) => void;
  /** Desk scopes in the order you visited them, most recent first (the shell keeps it); orders "recent" and picks the row to start on. */
  visited?: string[];
  /** ⇧↵: switch and put the cursor in the chat. */
  onSwitchChat?: (scope: Scope) => void;
}

/** Every row the arrows can land on, in display order: the desks, "new desk", then the archive when it shows. */
function buildRows(ordered: DeskSummary[], archive: DeskSummary[], newRow: Row | null, showArchive: boolean): Row[] {
  const out: Row[] = ordered.map((d) => ({ kind: "desk", desk: d }));
  if (newRow) out.push(newRow);
  if (showArchive) for (const d of archive) out.push({ kind: "desk", desk: d });
  return out;
}

const plural = (n: number) => `${n} desk${n === 1 ? "" : "s"}`;

type Chip = { id: string; name: string | null; count: number };

/** What the hidden live region says: the agent filter (Tab changes it silently otherwise) and, while typing, how many desks match. */
export function statusLine(agentFilter: string | null, chips: Chip[], q: string, matching: number): string {
  const chip = chips.find((c) => c.id === agentFilter);
  const filterWord = agentFilter ? `${chip?.name ?? "agent"} · ${plural(chip?.count ?? 0)}` : "all agents";
  return q ? `${filterWord} · ${plural(matching)} match` : filterWord;
}

export type TreeKeyAction = "down" | "up" | "agent-next" | "agent-prev" | "choose" | "choose-chat" | "close" | "pin" | "archive";

/**
 * The filter box's keys as actions: ↑↓ move, Tab / ⇧Tab cycle the agent chips, ↵ opens, ⇧↵ opens with the
 * chat focused, Escape closes (one Escape; clearing a chip first surprised more than it helped), ⌘P pins
 * and ⌘E archives when the sheet has those handlers. Null for anything else, which the input keeps.
 */
export function treeKey(e: Pick<KeyboardEvent, "key" | "shiftKey" | "metaKey" | "ctrlKey">, can: { pin: boolean; archive: boolean }): TreeKeyAction | null {
  if (e.key === "ArrowDown") return "down";
  if (e.key === "ArrowUp") return "up";
  if (e.key === "Tab") return e.shiftKey ? "agent-prev" : "agent-next";
  if (e.key === "Enter") return e.shiftKey ? "choose-chat" : "choose";
  if (e.key === "Escape") return "close";
  const cmd = (e.metaKey || e.ctrlKey) && !e.shiftKey;
  if (cmd && e.key.toLowerCase() === "p" && can.pin) return "pin";
  if (cmd && e.key.toLowerCase() === "e" && can.archive) return "archive";
  return null;
}

function TreeSheet({ onClose, desks, agents, items, current, onSwitch, onNew, heading, onPickDesk, onPin, onArchive, visited, onSwitchChat, showArchive, onToggleArchive }: Omit<TreeProps, "visited"> & { visited: string[]; showArchive: boolean; onToggleArchive: () => void }) {
  const [query, setQuery] = useState("");
  /** null: every agent. */
  const [agentFilter, setAgentFilter] = useState<string | null>(null);
  /** Where the highlight starts: the rows as they are with nothing typed, and initialIndex() picks the way back. */
  const [index, setIndex] = useState(() => {
    const start = buildRows(sectionDesks(desks, null, items, visited).flatMap((sec) => sec.desks), archivedDesks(desks, null, ""), onNew ? { kind: "new", agentId: null, name: "" } : null, showArchive);
    return initialIndex(start.map((r) => (r.kind === "desk" ? r.desk.scope : null)), visited, current);
  });
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const keyboardMove = useRef(false);
  /** The listbox's id; each option is `${listId}-opt-${index}` so the input can point at the highlighted one. */
  const listId = useId();
  const optionId = (i: number) => `${listId}-opt-${i}`;

  const marks = useMemo(() => {
    const m = new Map<string, AttentionItem>();
    for (const i of items) m.set(`${i.agentId}/${i.id}`, i);
    return m;
  }, [items]);

  /** Chips: the agents the server lists, plus any agent only the desks know. */
  const chips = useMemo(() => agentChips(agents, desks), [agents, desks]);
  const liveCount = useMemo(() => desks.filter((d) => d.status === "live").length, [desks]);

  const q = query.trim().toLowerCase();
  const live = useMemo(() => liveDesks(desks, agentFilter, q), [desks, q, agentFilter]);
  const archive = useMemo(() => archivedDesks(desks, agentFilter, q), [desks, q, agentFilter]);
  /** Nothing typed: the sectioned order. Typing: one flat list of matches. */
  const sections = useMemo<Section[]>(() => (q ? [{ id: "rest", label: "", desks: live }] : sectionDesks(desks, agentFilter, items, visited)), [q, live, desks, agentFilter, items, visited]);
  const ordered = useMemo(() => sections.flatMap((sec) => sec.desks), [sections]);

  const rows = useMemo<Row[]>(() => buildRows(ordered, archive, onNew ? { kind: "new", agentId: agentFilter, name: q && live.length === 0 ? query.trim() : "" } : null, showArchive || !!q), [ordered, live, archive, q, query, showArchive, onNew, agentFilter]);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    if (index >= rows.length) setIndex(Math.max(0, rows.length - 1));
  }, [rows.length, index]);
  useEffect(() => {
    if (!keyboardMove.current) return;
    keyboardMove.current = false;
    listRef.current?.querySelector<HTMLElement>(`[role="option"][data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const choose = (row: Row | undefined, chat = false) => {
    if (!row) return;
    onClose();
    if (row.kind === "new") onNew?.(row.agentId, row.name);
    else if (onPickDesk) onPickDesk(row.desk);
    else if (chat && onSwitchChat) onSwitchChat(row.desk.scope);
    else if (row.desk.scope !== current) onSwitch(row.desk.scope);
  };
  const cycleAgent = (dir: 1 | -1) => {
    const order: Array<string | null> = [null, ...chips.map((c) => c.id)];
    const i = order.indexOf(agentFilter);
    setAgentFilter(order[(i + dir + order.length) % order.length]);
    setIndex(0);
  };

  const pickAgent = (id: string | null) => {
    setAgentFilter(id);
    setIndex(0);
  };
  const onKey = (e: React.KeyboardEvent) => {
    const action = treeKey(e, { pin: !!onPin, archive: !!onArchive });
    if (!action) return;
    e.preventDefault();
    const r = rows[index];
    if (action === "down" || action === "up") {
      keyboardMove.current = true;
      setIndex((i) => (action === "down" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1)));
    } else if (action === "agent-next" || action === "agent-prev") cycleAgent(action === "agent-next" ? 1 : -1);
    else if (action === "choose" || action === "choose-chat") choose(r, action === "choose-chat");
    else if (action === "close") onClose();
    else if (action === "pin") {
      if (r?.kind === "desk") onPin!(r.desk, !r.desk.pinned);
    } else if (action === "archive") {
      if (r?.kind === "desk" && r.desk.conversationId && r.desk.conversationId !== "default") onArchive!(r.desk, r.desk.status !== "archived");
    }
  };

  let cursor = 0;
  const rowIndex = () => cursor++;
  const pickName = (agentId: string | null) => chips.find((c) => c.id === agentId)?.name ?? null;
  const statusWord = statusLine(agentFilter, chips, q, live.length + archive.length);
  /** The "new desk" row files the typed name when nothing matches it. */
  const newName = q && live.length === 0 ? query.trim() : "";

  return (
    // Escape is the input's (below) and the shell's (window-level, when nothing is typing); the sheet stays out of it.
    <Sheet label="desks" onClose={onClose} width={TREE_WIDTH} top="6vh" escape={false} cardProps={{ "data-tree": true }}>
      {heading && <div className="loki-label" style={{ padding: "12px 16px 0", fontSize: 9.5, color: "var(--loki-accent)" }}>{heading}</div>}
      <Field
        bare
        ref={inputRef}
        type="search"
        name="desk-search"
        autoComplete="off"
        data-1p-ignore
        data-lpignore="true"
        data-bwignore
        data-form-type="other"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0);
        }}
        onKeyDown={onKey}
        placeholder={agentFilter ? `find a desk of ${pickName(agentFilter) ?? "this agent"}…` : "find a desk…"}
        aria-label="find a desk"
        role="combobox"
        aria-expanded={true}
        aria-autocomplete="list"
        aria-controls={listId}
        aria-activedescendant={rows.length > 0 ? optionId(index) : undefined}
        style={{ flex: "0 0 auto" }}
      />
      {/* Tab cycles the chips and typing filters the list without moving focus, so a screen reader hears the change here. */}
      <span role="status" className="sr-only">
        {statusWord}
      </span>

      <AgentChips chips={chips} liveCount={liveCount} agentFilter={agentFilter} onPick={pickAgent} />

      <div ref={listRef} id={listId} role="listbox" aria-label="desks" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "6px 8px 10px" }}>
        {sections.map((sec) => (
          // A labelled section is a group the listbox may hold; its visible heading is the group's name, so it hides from the tree.
          <div key={sec.id} role={sec.label ? "group" : "presentation"} aria-label={sec.label || undefined}>
            {sec.label && <div aria-hidden className="loki-label" style={{ fontSize: 9.5, padding: "8px 10px 3px", color: sec.id === "waiting" ? "var(--loki-accent)" : undefined }}>{sec.label}</div>}
            {sec.desks.map((d) => (
              <DeskRow key={d.scope} desk={d} mark={marks.get(`${d.agentId}/${d.conversationId}`)} here={d.scope === current} showFace={!agentFilter} index={rowIndex()} optionId={optionId} selected={index} onHover={setIndex} onChoose={() => choose({ kind: "desk", desk: d })} onPin={onPin} onArchive={onArchive} />
            ))}
          </div>
        ))}
        {onNew && (
          <NewRow
            index={rowIndex()}
            optionId={optionId}
            selected={index}
            onHover={setIndex}
            onChoose={() => choose({ kind: "new", agentId: agentFilter, name: newName })}
            label={<NewRowLabel name={newName} agentFilter={agentFilter} agentName={pickName(agentFilter)} />}
          />
        )}
        {archive.length > 0 && <ArchiveGroup archive={archive} open={showArchive || !!q} onToggle={onToggleArchive} startIndex={cursor} current={current} showFace={!agentFilter} optionId={optionId} selected={index} onHover={setIndex} onChoose={(d) => choose({ kind: "desk", desk: d })} onPin={onPin} onArchive={onArchive} />}
        {rows.length === 0 && <div role="status" style={{ padding: 14, fontSize: 12, color: "var(--loki-muted)" }}>no desks match</div>}
      </div>
      <TreeFooter onPickDesk={onPickDesk} onSwitchChat={onSwitchChat} onPin={onPin} onArchive={onArchive} />
    </Sheet>
  );
}

/** The agent filter: "all" with the live count, then one chip per agent; a chip pressed again clears it. */
function AgentChips({ chips, liveCount, agentFilter, onPick }: { chips: Chip[]; liveCount: number; agentFilter: string | null; onPick: (id: string | null) => void }) {
  return (
    <div role="group" aria-label="filter by agent" style={{ display: "flex", gap: 6, padding: "8px 12px", borderBottom: "1px solid var(--loki-border)", overflowX: "auto", flex: "0 0 auto" }}>
      <Chip label aria-pressed={agentFilter === null} brass={agentFilter === null} onClick={() => onPick(null)}>
        all <span style={{ opacity: 0.7 }}>{liveCount}</span>
      </Chip>
      {chips.map((c) => (
        <Chip key={c.id} label aria-pressed={agentFilter === c.id} brass={agentFilter === c.id} onClick={() => onPick(agentFilter === c.id ? null : c.id)}>
          <AgentFace name={c.name} src={avatarUrl(c.id)} size={14} />
          {c.name ?? "agent"} <span style={{ opacity: 0.7 }}>{c.count}</span>
        </Chip>
      ))}
    </div>
  );
}

/** The "new desk" row's words: the typed name in quotes when nothing matches it, else plain; the agent when one is filtered. */
function NewRowLabel({ name, agentFilter, agentName }: { name: string; agentFilter: string | null; agentName: string | null }) {
  return name ? (
    <>
      create desk <span style={{ fontFamily: "var(--loki-display)" }}>“{name}”</span>
      {agentFilter ? ` with ${agentName}` : ""}
    </>
  ) : (
    `new desk${agentFilter ? ` with ${agentName}` : "…"}`
  );
}

type RowHandlers = { optionId: (i: number) => string; selected: number; onHover: (i: number) => void; onPin?: (desk: DeskSummary, pinned: boolean) => void; onArchive?: (desk: DeskSummary, archived: boolean) => void };

/** The folded group at the bottom: archived and deleted conversations. Its rows take the indices after the live ones, from `startIndex`. */
function ArchiveGroup({ archive, open, onToggle, startIndex, current, showFace, onChoose, ...row }: RowHandlers & { archive: DeskSummary[]; open: boolean; onToggle: () => void; startIndex: number; current: Scope; showFace: boolean; onChoose: (d: DeskSummary) => void }) {
  return (
    <div role="group" aria-label="archive" style={{ marginTop: 10 }}>
      <button
        onClick={onToggle}
        className="loki-label"
        aria-expanded={open}
        style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "4px 8px", border: "none", background: "transparent", color: "var(--loki-muted)", cursor: "pointer", fontSize: 9.5, textAlign: "left" }}
      >
        <span style={{ display: "inline-block", transform: open ? "rotate(90deg)" : "none", transition: "transform 120ms" }}>▸</span>
        archive
        <span style={{ marginLeft: "auto", fontFamily: "var(--loki-mono)", letterSpacing: 0 }}>{archive.length}</span>
      </button>
      {open && archive.map((d, i) => <DeskRow key={d.scope} desk={d} mark={undefined} here={d.scope === current} showFace={showFace} index={startIndex + i} onChoose={() => onChoose(d)} {...row} />)}
    </div>
  );
}

/** The key legend along the bottom; it names only what this sheet can do. */
function TreeFooter({ onPickDesk, onSwitchChat, onPin, onArchive }: Pick<TreeProps, "onPickDesk" | "onSwitchChat" | "onPin" | "onArchive">) {
  return (
    <div style={{ flex: "0 0 auto", padding: "6px 14px", fontSize: 10.5, color: "var(--loki-muted)", borderTop: "1px solid var(--loki-border)", letterSpacing: "0.06em", fontFamily: "var(--loki-mono)" }}>
      {onPickDesk ? "↑↓ move · tab agent · ↵ choose · esc cancel" : `↑↓ move · tab agent · ↵ open${onSwitchChat ? " · ⇧↵ chat" : ""}${onPin ? " · ⌘P pin" : ""}${onArchive ? " · ⌘E archive" : ""} · esc`}
    </div>
  );
}

function when(iso: string | null): string {
  if (!iso) return "";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** The dot before a desk: brass when it waits on you, hollow when it finished unread, a faint ring while it runs. */
export function Mark({ item, status, size = 7 }: { item: AttentionItem | undefined; status: DeskSummary["status"]; size?: number }) {
  const { color, border, title, pulse } = deskMark(item, status);
  return <Dot aria-label={title || undefined} title={title || undefined} pulse={pulse} size={size} color={border} ring={color === "transparent"} />;
}

/** A hover action's click stays on the button: the row underneath would otherwise open the desk. */
const act = (fn: () => void) => (e: React.MouseEvent) => {
  e.stopPropagation();
  fn();
};

/** A conversation can be archived unless it is the agent's default or already deleted. */
const canArchiveDesk = (d: DeskSummary, onArchive: RowHandlers["onArchive"]) => !!onArchive && !!d.conversationId && d.conversationId !== "default" && d.status !== "deleted";
/** A live desk with an agent and a conversation can be pinned. */
const canPinDesk = (d: DeskSummary, onPin: RowHandlers["onPin"]) => !!onPin && !!d.agentId && !!d.conversationId && d.status === "live";

function DeskRow({ desk: d, mark, here, showFace, index, optionId, selected, onHover, onChoose, onPin, onArchive }: RowHandlers & { desk: DeskSummary; mark: AttentionItem | undefined; here: boolean; showFace: boolean; index: number; onChoose: () => void }) {
  const canArchive = canArchiveDesk(d, onArchive);
  const canPin = canPinDesk(d, onPin);
  return (
    <div
      id={optionId(index)}
      role="option"
      data-index={index}
      aria-selected={index === selected}
      onMouseEnter={() => onHover(index)}
      onClick={onChoose}
      className="loki-tree-row"
      style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 10px", borderRadius: 8, cursor: "pointer", background: index === selected ? "var(--loki-accent-soft)" : "transparent", opacity: d.status === "live" ? 1 : 0.7 }}
    >
      <Mark item={mark} status={d.status} />
      {showFace && (d.agentId ? <AgentFace name={d.agentName} src={avatarUrl(d.agentId)} size={18} /> : <AgentChip name={d.agentName} size={9.5} />)}
      <span style={{ flex: 1, minWidth: 0, fontFamily: "var(--loki-display)", fontSize: 13.5, color: "var(--loki-fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {d.pinned && <span aria-label="pinned" title="pinned" style={{ color: "var(--loki-accent)", marginRight: 6, fontSize: 10.5 }}>⌖</span>}
        {d.title ?? (d.status === "live" ? "new desk" : d.scope)}
        {here && <span style={{ color: "var(--loki-muted)", marginLeft: 8, fontSize: 10.5, fontFamily: "var(--loki-font)" }}>· here</span>}
      </span>
      {/* Hover actions take the place of the timestamp so the row never widens. */}
      <span className="loki-tree-meta" style={{ fontSize: 10.5, color: "var(--loki-muted)", fontFamily: "var(--loki-mono)", whiteSpace: "nowrap" }}>
        {when(d.lastActive)}
      </span>
      {(canPin || canArchive) && <RowActions desk={d} canPin={canPin} canArchive={canArchive} onPin={onPin} onArchive={onArchive} />}
    </div>
  );
}

/** The hover actions: pin and archive, as the row allows. */
function RowActions({ desk: d, canPin, canArchive, onPin, onArchive }: Pick<RowHandlers, "onPin" | "onArchive"> & { desk: DeskSummary; canPin: boolean; canArchive: boolean }) {
  return (
    <span className="loki-tree-actions" style={{ display: "none", gap: 2 }}>
      {canPin && (
        <IconButton size={24} tone={d.pinned ? "brass" : "quiet"} onClick={act(() => onPin!(d, !d.pinned))} title={d.pinned ? "unpin (⌘P)" : "pin to the top (⌘P)"} label={d.pinned ? "unpin" : "pin"}>
          ⌖
        </IconButton>
      )}
      {canArchive && (
        <IconButton size={24} onClick={act(() => onArchive!(d, d.status !== "archived"))} title={d.status === "archived" ? "restore from the archive (⌘E)" : "archive (⌘E)"} label={d.status === "archived" ? "restore" : "archive"}>
          {d.status === "archived" ? "↶" : "⊟"}
        </IconButton>
      )}
    </span>
  );
}

function NewRow({ index, optionId, selected, onHover, onChoose, label }: { index: number; optionId: (i: number) => string; selected: number; onHover: (i: number) => void; onChoose: () => void; label: React.ReactNode }) {
  return (
    <div
      id={optionId(index)}
      role="option"
      data-index={index}
      aria-selected={index === selected}
      onMouseEnter={() => onHover(index)}
      onClick={onChoose}
      style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 10px", marginTop: 4, borderRadius: 8, cursor: "pointer", background: index === selected ? "var(--loki-accent-soft)" : "transparent", color: "var(--loki-muted)", fontSize: 12 }}
    >
      <span style={{ width: 7, textAlign: "center", color: "var(--loki-accent)", fontSize: 13.5, lineHeight: 1 }}>+</span>
      <span>{label}</span>
    </div>
  );
}
