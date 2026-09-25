import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Chip, Dot, Field, Sheet } from "../components";
import type { Scope } from "../../../core/desk-core.ts";
import type { AttentionItem } from "../../../core/attention/model.ts";
import type { DeskSummary } from "../desk/useDesk";
import { AgentChip, AgentFace } from "../desk/AgentChip";
import { avatarUrl } from "../desk/env";
import { deskMark } from "./sidebarModel";
import { formatKeys } from "./keymap";

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

export type SectionId = "waiting" | "pinned" | "rest";
export interface Section {
  id: SectionId;
  label: string;
  desks: DeskSummary[];
}

/**
 * The picker's order when nothing is typed. Waiting on you first (an approval or a question — the red
 * dots), then pinned, then everything else by last message. Every desk appears once. With a query the
 * list is flat and liveDesks() decides; sections would only hide matches.
 */
export function sectionDesks(desks: DeskSummary[], agentFilter: string | null, items: AttentionItem[]): Section[] {
  const live = liveDesks(desks, agentFilter, "");
  const waits = new Set(items.filter((i) => i.status === "approval" || i.status === "question").map((i) => `${i.agentId}/${i.id}`));
  const placed = new Set<string>();
  const take = (pick: (d: DeskSummary) => boolean): DeskSummary[] => {
    const out: DeskSummary[] = [];
    for (const d of live) {
      if (placed.has(d.scope) || !pick(d)) continue;
      placed.add(d.scope);
      out.push(d);
    }
    return out;
  };
  const waiting = take((d) => waits.has(`${d.agentId}/${d.conversationId}`));
  const pinned = take((d) => !!d.pinned);
  const rest = take(() => true);
  const sections: Section[] = [
    { id: "waiting", label: "Waiting on you", desks: waiting },
    { id: "pinned", label: "Pinned", desks: pinned },
    { id: "rest", label: pinned.length || waiting.length ? "Everything else" : "Desks", desks: rest },
  ];
  return sections.filter((sec) => sec.desks.length > 0);
}

/** The folded group at the bottom: archived and deleted, in the mod's order. */
export function archivedDesks(desks: DeskSummary[], agentFilter: string | null, q: string): DeskSummary[] {
  return desks.filter((d) => d.status !== "live" && deskMatches(d, agentFilter, q));
}

// The mark and the pin / archive rules live in the sidebar's model now; the tree and the phone keep importing them from here.
export { deskMark, type MarkKind } from "./sidebarModel";

/**
 * The desks tree, now only the Board's assign-to-desk picker (PickerTree in views.tsx): the desk sidebar
 * lists desks and ⌘K searches them (plan 013), so switching, pinning and archiving from here went with the
 * drawer. Nothing typed: sections — waiting on you, pinned, everything else — and the highlight starts on the
 * current desk. Type to filter into one flat list. ↑↓ move, ↵ choose, Tab / ⇧Tab cycle the agent chips, esc
 * cancels. Archived and deleted conversations sit under a folded "archive" group at the bottom. Each desk
 * carries the same attention mark the inbox gives it.
 */
export function DeskTree({ open, ...props }: TreeProps & { open: boolean }) {
  /** The archive group's fold; it outlives the sheet, unlike the filter, so it stays with the wrapper. */
  const [showArchive, setShowArchive] = useState(false);
  // The sheet mounts with a blank filter each time it opens, and goes away with it.
  if (!open) return null;
  return <TreeSheet {...props} showArchive={showArchive} onToggleArchive={() => setShowArchive((v) => !v)} />;
}

interface TreeProps {
  onClose: () => void;
  desks: DeskSummary[];
  /** Agents the app-server knows; an agent with no desk yet still gets a chip. */
  agents: Array<{ id: string; name: string }>;
  items: AttentionItem[];
  current: Scope;
  /** Start a new desk for this agent (null: pick in the sheet); `name` when typed into the filter. */
  onNew?: (agentId: string | null, name: string) => void;
  /** A heading above the filter ("Assign 2 tasks to…"). */
  heading?: string | null;
  /** The desk chosen. */
  onPickDesk: (desk: DeskSummary) => void;
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

export type TreeKeyAction = "down" | "up" | "agent-next" | "agent-prev" | "choose" | "close";

/**
 * The filter box's keys as actions: ↑↓ move, Tab / ⇧Tab cycle the agent chips, ↵ chooses, Escape closes
 * (one Escape; clearing a chip first surprised more than it helped). Null for anything else, which the input keeps.
 */
export function treeKey(e: Pick<KeyboardEvent, "key" | "shiftKey">): TreeKeyAction | null {
  if (e.key === "ArrowDown") return "down";
  if (e.key === "ArrowUp") return "up";
  if (e.key === "Tab") return e.shiftKey ? "agent-prev" : "agent-next";
  if (e.key === "Enter" && !e.shiftKey) return "choose";
  if (e.key === "Escape") return "close";
  return null;
}

function TreeSheet({ onClose, desks, agents, items, current, onNew, heading, onPickDesk, showArchive, onToggleArchive }: TreeProps & { showArchive: boolean; onToggleArchive: () => void }) {
  const [query, setQuery] = useState("");
  /** null: every agent. */
  const [agentFilter, setAgentFilter] = useState<string | null>(null);
  /** Where the highlight starts: the current desk among the rows as they are with nothing typed, else the top. */
  const [index, setIndex] = useState(() => {
    const start = buildRows(sectionDesks(desks, null, items).flatMap((sec) => sec.desks), archivedDesks(desks, null, ""), onNew ? { kind: "new", agentId: null, name: "" } : null, showArchive);
    return Math.max(0, start.findIndex((r) => r.kind === "desk" && r.desk.scope === current));
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
  const sections = useMemo<Section[]>(() => (q ? [{ id: "rest", label: "", desks: live }] : sectionDesks(desks, agentFilter, items)), [q, live, desks, agentFilter, items]);
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

  const choose = (row: Row | undefined) => {
    if (!row) return;
    onClose();
    if (row.kind === "new") onNew?.(row.agentId, row.name);
    else onPickDesk(row.desk);
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
    const action = treeKey(e);
    if (!action) return;
    e.preventDefault();
    const r = rows[index];
    if (action === "down" || action === "up") {
      keyboardMove.current = true;
      setIndex((i) => (action === "down" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1)));
    } else if (action === "agent-next" || action === "agent-prev") cycleAgent(action === "agent-next" ? 1 : -1);
    else if (action === "choose") choose(r);
    else if (action === "close") onClose();
  };

  // Each option's place in `rows`, top to bottom: the sections' desks, the "new desk" row, then the archive.
  const starts = sectionStarts(sections);
  const newIndex = ordered.length;
  const archiveStart = ordered.length + (onNew ? 1 : 0);
  const pickName = (agentId: string | null) => chips.find((c) => c.id === agentId)?.name ?? null;
  const statusWord = statusLine(agentFilter, chips, q, live.length + archive.length);
  /** The "new desk" row files the typed name when nothing matches it. */
  const newName = q && live.length === 0 ? query.trim() : "";

  return (
    // Escape is the input's (below) and the shell's (window-level, when nothing is typing); the sheet stays out of it.
    <Sheet label="desks" onClose={onClose} width={TREE_WIDTH} top="6vh" escape={false} cardProps={{ "data-tree": true }}>
      {heading && <div className="loki-label" style={{ padding: "12px 16px 0", color: "var(--loki-fg)" }}>{heading}</div>}
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
        {sections.map((sec, si) => (
          // A labelled section is a group the listbox may hold; its visible heading is the group's name, so it hides from the tree.
          <div key={sec.id} role={sec.label ? "group" : "presentation"} aria-label={sec.label || undefined}>
            {sec.label && <div aria-hidden className="loki-label" style={{ padding: "8px 10px 3px", color: sec.id === "waiting" ? "var(--loki-fg)" : undefined }}>{sec.label}</div>}
            {sec.desks.map((d, i) => (
              <DeskRow key={d.scope} desk={d} mark={marks.get(`${d.agentId}/${d.conversationId}`)} here={d.scope === current} showFace={!agentFilter} index={starts[si] + i} optionId={optionId} selected={index} onHover={setIndex} onChoose={() => choose({ kind: "desk", desk: d })} />
            ))}
          </div>
        ))}
        {onNew && (
          <NewRow
            index={newIndex}
            optionId={optionId}
            selected={index}
            onHover={setIndex}
            onChoose={() => choose({ kind: "new", agentId: agentFilter, name: newName })}
            label={<NewRowLabel name={newName} agentFilter={agentFilter} agentName={pickName(agentFilter)} />}
          />
        )}
        {archive.length > 0 && <ArchiveGroup archive={archive} open={showArchive || !!q} onToggle={onToggleArchive} startIndex={archiveStart} current={current} showFace={!agentFilter} optionId={optionId} selected={index} onHover={setIndex} onChoose={(d) => choose({ kind: "desk", desk: d })} />}
        {rows.length === 0 && <div role="status" className="loki-meta loki-meta--wrap" style={{ padding: 14 }}>no desks match</div>}
      </div>
      <div className="loki-meta loki-meta--wrap" style={{ flex: "0 0 auto", padding: "6px 14px", borderTop: "1px solid var(--loki-border)", fontFamily: "var(--loki-mono)" }}>
        {`↑↓ move · tab agent · ${formatKeys("enter")} choose · ${formatKeys("escape")} cancel`}
      </div>
    </Sheet>
  );
}

/** The agent filter: "all" with the live count, then one chip per agent; a chip pressed again clears it. */
function AgentChips({ chips, liveCount, agentFilter, onPick }: { chips: Chip[]; liveCount: number; agentFilter: string | null; onPick: (id: string | null) => void }) {
  return (
    <div role="group" aria-label="filter by agent" style={{ display: "flex", gap: 6, padding: "8px 12px", borderBottom: "1px solid var(--loki-border)", overflowX: "auto", flex: "0 0 auto" }}>
      <Chip label aria-pressed={agentFilter === null} active={agentFilter === null} onClick={() => onPick(null)}>
        all <span style={{ opacity: 0.7 }}>{liveCount}</span>
      </Chip>
      {chips.map((c) => (
        <Chip key={c.id} label aria-pressed={agentFilter === c.id} active={agentFilter === c.id} onClick={() => onPick(agentFilter === c.id ? null : c.id)}>
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
      create desk <span style={{ fontWeight: 600, color: "var(--loki-fg)" }}>“{name}”</span>
      {agentFilter ? ` with ${agentName}` : ""}
    </>
  ) : (
    `new desk${agentFilter ? ` with ${agentName}` : "…"}`
  );
}

type RowHandlers = { optionId: (i: number) => string; selected: number; onHover: (i: number) => void };

/** The folded group at the bottom: archived and deleted conversations. Its rows take the indices after the live ones, from `startIndex`. */
/** Where each section's desks start among the options (a counter bumped in render keeps the React Compiler off). */
function sectionStarts(sections: ReadonlyArray<{ desks: readonly unknown[] }>): number[] {
  const out: number[] = [];
  let at = 0;
  for (const sec of sections) {
    out.push(at);
    at += sec.desks.length;
  }
  return out;
}

function ArchiveGroup({ archive, open, onToggle, startIndex, current, showFace, onChoose, ...row }: RowHandlers & { archive: DeskSummary[]; open: boolean; onToggle: () => void; startIndex: number; current: Scope; showFace: boolean; onChoose: (d: DeskSummary) => void }) {
  return (
    <div role="group" aria-label="archive" style={{ marginTop: 10 }}>
      <button
        onClick={onToggle}
        className="loki-label"
        aria-expanded={open}
        style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "4px 8px", border: "none", background: "transparent", color: "var(--loki-muted)", cursor: "pointer", textAlign: "left" }}
      >
        <span style={{ display: "inline-block", transform: open ? "rotate(90deg)" : "none", transition: "transform 120ms" }}>▸</span>
        Archive
        <span style={{ marginLeft: "auto" }}>{archive.length}</span>
      </button>
      {open && archive.map((d, i) => <DeskRow key={d.scope} desk={d} mark={undefined} here={d.scope === current} showFace={showFace} index={startIndex + i} onChoose={() => onChoose(d)} {...row} />)}
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

/** The dot before a desk: red when it waits on you, an fg ring when it finished unread, a faint ring while it runs. */
export function Mark({ item, status, size = 7 }: { item: AttentionItem | undefined; status: DeskSummary["status"]; size?: number }) {
  const { color, border, title, pulse } = deskMark(item, status);
  return <Dot aria-label={title || undefined} title={title || undefined} pulse={pulse} size={size} color={border} ring={color === "transparent"} />;
}

function DeskRow({ desk: d, mark, here, showFace, index, optionId, selected, onHover, onChoose }: RowHandlers & { desk: DeskSummary; mark: AttentionItem | undefined; here: boolean; showFace: boolean; index: number; onChoose: () => void }) {
  // Something new in it (it waits on you, or it finished unread): the name goes bold, like Slack's unread.
  const fresh = ["waits", "finished"].includes(deskMark(mark, d.status).kind);
  return (
    <div
      id={optionId(index)}
      role="option"
      data-index={index}
      aria-selected={index === selected}
      onMouseEnter={() => onHover(index)}
      onClick={onChoose}
      style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 10px", borderRadius: "var(--loki-radius-md)", cursor: "pointer", background: index === selected ? "var(--loki-selection)" : "transparent", opacity: d.status === "live" ? 1 : 0.7 }}
    >
      <Mark item={mark} status={d.status} />
      {showFace && (d.agentId ? <AgentFace name={d.agentName} src={avatarUrl(d.agentId)} size={18} /> : <AgentChip name={d.agentName} size={9.5} />)}
      <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: fresh ? 700 : undefined, color: "var(--loki-fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {d.pinned && <span aria-label="pinned" title="pinned" style={{ color: "var(--loki-accent)", marginRight: 6, fontSize: 10.5 }}>⌖</span>}
        {d.title ?? (d.status === "live" ? "new desk" : d.scope)}
        {here && <span style={{ color: "var(--loki-muted)", marginLeft: 8, fontSize: 10.5, fontFamily: "var(--loki-font)" }}>· here</span>}
      </span>
      <span className="loki-meta">{when(d.lastActive)}</span>
    </div>
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
      style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 10px", marginTop: 4, borderRadius: "var(--loki-radius-md)", cursor: "pointer", background: index === selected ? "var(--loki-selection)" : "transparent", color: "var(--loki-muted)", fontSize: 12 }}
    >
      <span style={{ width: 7, textAlign: "center", color: "var(--loki-accent)", fontSize: 13.5, lineHeight: 1 }}>+</span>
      <span>{label}</span>
    </div>
  );
}
