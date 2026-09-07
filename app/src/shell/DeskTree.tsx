import { useEffect, useMemo, useRef, useState } from "react";
import { LAYER } from "../kit/layers";
import type { Scope } from "../../../packages/core/src/desk-core.ts";
import type { AttentionItem } from "../../../packages/core/src/attention/model.ts";
import type { DeskSummary } from "../desk/useDesk";
import { AgentChip, AgentFace } from "../desk/AgentChip";
import { avatarUrl } from "../desk/env";

export const TREE_WIDTH = 560;

type Row = { kind: "desk"; desk: DeskSummary } | { kind: "new"; agentId: string | null; name: string };

/**
 * The desks tree: one centred list, every desk of every agent, pinned first then by recency, with the
 * agent's face on each row. A chip row under the search filters to one agent (click, or Tab / ⇧Tab).
 * Type to filter, ↑↓ move, ↵ open, ⌘P pin, ⌘E archive, esc close. Archived and deleted conversations
 * sit under a folded "archive" group at the bottom. Each desk carries the same attention mark the inbox gives it.
 */
export function DeskTree({
  open,
  onClose,
  desks,
  agents,
  items,
  current,
  onSwitch,
  onNew,
  heading,
  onPickDesk,
  onPin,
  onArchive,
}: {
  open: boolean;
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
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [showArchive, setShowArchive] = useState(false);
  /** null: every agent. */
  const [agentFilter, setAgentFilter] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const keyboardMove = useRef(false);

  const marks = useMemo(() => {
    const m = new Map<string, AttentionItem>();
    for (const i of items) m.set(`${i.agentId}/${i.id}`, i);
    return m;
  }, [items]);

  /** Chips: the agents the server lists, plus any agent only the desks know. */
  const chips = useMemo(() => {
    const byId = new Map<string, { id: string; name: string | null; count: number }>();
    for (const a of agents) byId.set(a.id, { id: a.id, name: a.name, count: 0 });
    for (const d of desks) {
      if (d.status !== "live" || !d.agentId) continue;
      if (!byId.has(d.agentId)) byId.set(d.agentId, { id: d.agentId, name: d.agentName, count: 0 });
      byId.get(d.agentId)!.count++;
    }
    return [...byId.values()];
  }, [agents, desks]);
  const liveCount = useMemo(() => desks.filter((d) => d.status === "live").length, [desks]);

  const q = query.trim().toLowerCase();
  const matches = (d: DeskSummary) =>
    (!agentFilter || d.agentId === agentFilter) && (!q || (d.title ?? "").toLowerCase().includes(q) || d.scope.toLowerCase().includes(q) || (d.agentName ?? "").toLowerCase().includes(q));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const live = useMemo(() => desks.filter((d) => d.status === "live" && d.scope !== "shared" && matches(d)).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (b.lastActive ?? "").localeCompare(a.lastActive ?? "")), [desks, q, agentFilter]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const archive = useMemo(() => desks.filter((d) => d.status !== "live" && matches(d)), [desks, q, agentFilter]);

  /** Every row the arrows can land on, in display order. */
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = live.map((d) => ({ kind: "desk", desk: d }));
    if (onNew) out.push({ kind: "new", agentId: agentFilter, name: q && live.length === 0 ? query.trim() : "" });
    if (showArchive || q) for (const d of archive) out.push({ kind: "desk", desk: d });
    return out;
  }, [live, archive, q, query, showArchive, onNew, agentFilter]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setAgentFilter(null);
      setIndex(Math.max(0, rows.findIndex((r) => r.kind === "desk" && r.desk.scope === current)));
      setTimeout(() => inputRef.current?.focus(), 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (index >= rows.length) setIndex(Math.max(0, rows.length - 1));
  }, [rows.length, index]);
  useEffect(() => {
    if (!keyboardMove.current) return;
    keyboardMove.current = false;
    listRef.current?.querySelector<HTMLElement>(`[role="option"][data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  if (!open) return null;

  const choose = (row: Row | undefined) => {
    if (!row) return;
    onClose();
    if (row.kind === "new") onNew?.(row.agentId, row.name);
    else if (onPickDesk) onPickDesk(row.desk);
    else if (row.desk.scope !== current) onSwitch(row.desk.scope);
  };
  const cycleAgent = (dir: 1 | -1) => {
    const order: Array<string | null> = [null, ...chips.map((c) => c.id)];
    const i = order.indexOf(agentFilter);
    setAgentFilter(order[(i + dir + order.length) % order.length]);
    setIndex(0);
  };

  let cursor = 0;
  const rowIndex = () => cursor++;
  const pickName = (agentId: string | null) => chips.find((c) => c.id === agentId)?.name ?? null;

  return (
    <div
      onPointerDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
      style={{ position: "absolute", inset: 0, background: "var(--loki-veil)", zIndex: LAYER.modal, display: "grid", placeItems: "start center", paddingTop: "6vh", boxSizing: "border-box" }}
    >
      <div
        role="dialog"
        data-tree
        aria-label="desks"
        className="loki-sheet"
        style={{ width: TREE_WIDTH, maxWidth: "calc(100% - 48px)", maxHeight: "84vh", background: "var(--loki-panel)", border: "1px solid var(--loki-border)", borderRadius: 12, boxShadow: "var(--loki-shadow-sheet)", display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        {heading && <div className="loki-label" style={{ padding: "12px 16px 0", fontSize: 9.5, color: "var(--loki-accent)" }}>{heading}</div>}
        <input
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
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              keyboardMove.current = true;
              setIndex((i) => Math.min(rows.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              keyboardMove.current = true;
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === "Tab") {
              e.preventDefault();
              cycleAgent(e.shiftKey ? -1 : 1);
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(rows[index]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              if (agentFilter) setAgentFilter(null);
              else onClose();
            } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "p" && onPin) {
              e.preventDefault();
              const r = rows[index];
              if (r?.kind === "desk") onPin(r.desk, !r.desk.pinned);
            } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "e" && onArchive) {
              e.preventDefault();
              const r = rows[index];
              if (r?.kind === "desk" && r.desk.conversationId && r.desk.conversationId !== "default") onArchive(r.desk, r.desk.status !== "archived");
            }
          }}
          placeholder={agentFilter ? `find a desk of ${pickName(agentFilter) ?? "this agent"}…` : "find a desk…"}
          aria-label="find a desk"
          style={{ width: "100%", boxSizing: "border-box", padding: "13px 16px", fontSize: 13.5, background: "transparent", border: "none", borderBottom: "1px solid var(--loki-border)", color: "var(--loki-fg)", outline: "none" }}
        />

        {/* agent filter */}
        <div role="tablist" aria-label="agent" style={{ display: "flex", gap: 6, padding: "8px 12px", borderBottom: "1px solid var(--loki-border)", overflowX: "auto" }}>
          <Chip active={agentFilter === null} onClick={() => (setAgentFilter(null), setIndex(0))}>
            all <span style={{ opacity: 0.7 }}>{liveCount}</span>
          </Chip>
          {chips.map((c) => (
            <Chip key={c.id} active={agentFilter === c.id} onClick={() => (setAgentFilter(agentFilter === c.id ? null : c.id), setIndex(0))}>
              <AgentFace name={c.name} src={avatarUrl(c.id)} size={14} />
              {c.name ?? "agent"} <span style={{ opacity: 0.7 }}>{c.count}</span>
            </Chip>
          ))}
        </div>

        <div ref={listRef} role="listbox" aria-label="desks" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "6px 8px 10px" }}>
          {live.map((d) => (
            <DeskRow key={d.scope} desk={d} mark={marks.get(`${d.agentId}/${d.conversationId}`)} here={d.scope === current} showFace={!agentFilter} index={rowIndex()} selected={index} onHover={setIndex} onChoose={() => choose({ kind: "desk", desk: d })} onPin={onPin} onArchive={onArchive} />
          ))}
          {onNew && (
            <NewRow
              index={rowIndex()}
              selected={index}
              onHover={setIndex}
              onChoose={() => choose({ kind: "new", agentId: agentFilter, name: q && live.length === 0 ? query.trim() : "" })}
              label={
                q && live.length === 0 ? (
                  <>
                    create desk <span style={{ fontFamily: "var(--loki-display)" }}>“{query.trim()}”</span>
                    {agentFilter ? ` with ${pickName(agentFilter)}` : ""}
                  </>
                ) : (
                  `new desk${agentFilter ? ` with ${pickName(agentFilter)}` : "…"}`
                )
              }
            />
          )}
          {archive.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <button
                onClick={() => setShowArchive((v) => !v)}
                className="loki-label"
                aria-expanded={showArchive || !!q}
                style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "4px 8px", border: "none", background: "transparent", color: "var(--loki-muted)", cursor: "pointer", fontSize: 9.5, textAlign: "left" }}
              >
                <span style={{ display: "inline-block", transform: showArchive || q ? "rotate(90deg)" : "none", transition: "transform 120ms" }}>▸</span>
                archive
                <span style={{ marginLeft: "auto", fontFamily: "var(--loki-mono)", letterSpacing: 0 }}>{archive.length}</span>
              </button>
              {(showArchive || q) && archive.map((d) => <DeskRow key={d.scope} desk={d} mark={undefined} here={d.scope === current} showFace={!agentFilter} index={rowIndex()} selected={index} onHover={setIndex} onChoose={() => choose({ kind: "desk", desk: d })} onPin={onPin} onArchive={onArchive} />)}
            </div>
          )}
          {rows.length === 0 && <div style={{ padding: 14, fontSize: 12, color: "var(--loki-muted)" }}>no desks match</div>}
        </div>
        <div style={{ padding: "6px 14px", fontSize: 10.5, color: "var(--loki-muted)", borderTop: "1px solid var(--loki-border)", letterSpacing: "0.06em", fontFamily: "var(--loki-mono)" }}>
          {onPickDesk ? "↑↓ move · tab agent · ↵ choose · esc cancel" : `↑↓ move · tab agent · ↵ open${onPin ? " · ⌘P pin" : ""}${onArchive ? " · ⌘E archive" : ""} · esc`}
        </div>
      </div>
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className="loki-label"
      style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", border: `1px solid ${active ? "var(--loki-accent)" : "var(--loki-border)"}`, borderRadius: 999, background: active ? "var(--loki-brass-soft)" : "transparent", color: active ? "var(--loki-accent)" : "var(--loki-muted)", cursor: "pointer", fontSize: 9.5, whiteSpace: "nowrap", textTransform: "none", letterSpacing: "0.06em" }}
    >
      {children}
    </button>
  );
}

function when(iso: string | null): string {
  if (!iso) return "";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** The dot before a desk: brass when it waits on you, hollow when it finished unread, a faint ring while it runs. */
function Mark({ item, status }: { item: AttentionItem | undefined; status: DeskSummary["status"] }) {
  let color = "transparent";
  let border = "transparent";
  let title = "";
  let pulse = false;
  if (status === "deleted") {
    border = "var(--loki-negative)";
    title = "conversation deleted";
  } else if (status === "archived") {
    border = "var(--loki-muted)";
    title = "archived";
  } else if (item) {
    if (item.status === "approval" || item.status === "question") {
      color = border = "var(--loki-accent)";
      title = item.status === "approval" ? "needs approval" : "asked you";
    } else if (item.status === "failed") {
      color = border = "var(--loki-negative)";
      title = "failed";
    } else if (item.status === "done" && item.unread && !item.snooze) {
      border = "var(--loki-accent)";
      title = "finished, unread";
    } else if (item.status === "running") {
      border = "var(--loki-muted)";
      title = "running";
      pulse = true;
    }
  }
  return <span aria-label={title || undefined} title={title || undefined} style={{ width: 7, height: 7, borderRadius: 4, background: color, border: `1px solid ${border}`, boxSizing: "border-box", flex: "0 0 auto", animation: pulse ? "loki-pulse 1.6s ease-in-out infinite" : undefined }} />;
}

function DeskRow({ desk: d, mark, here, showFace, index, selected, onHover, onChoose, onPin, onArchive }: { desk: DeskSummary; mark: AttentionItem | undefined; here: boolean; showFace: boolean; index: number; selected: number; onHover: (i: number) => void; onChoose: () => void; onPin?: (desk: DeskSummary, pinned: boolean) => void; onArchive?: (desk: DeskSummary, archived: boolean) => void }) {
  const canArchive = !!onArchive && !!d.conversationId && d.conversationId !== "default" && d.status !== "deleted";
  const canPin = !!onPin && !!d.agentId && !!d.conversationId && d.status === "live";
  const act = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  return (
    <div
      role="option"
      data-index={index}
      aria-selected={index === selected}
      onMouseEnter={() => onHover(index)}
      onClick={onChoose}
      className="loki-tree-row"
      style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 10px", borderRadius: 8, cursor: "pointer", background: index === selected ? "var(--loki-accent-soft)" : "transparent", opacity: d.status === "live" ? 1 : 0.7 }}
    >
      <Mark item={mark} status={d.status} />
      {showFace && (d.agentId ? <AgentFace name={d.agentName} src={avatarUrl(d.agentId)} size={18} /> : <AgentChip name={d.agentName} size={9} />)}
      <span style={{ flex: 1, minWidth: 0, fontFamily: "var(--loki-display)", fontSize: 13.5, color: "var(--loki-fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {d.pinned && <span aria-label="pinned" title="pinned" style={{ color: "var(--loki-accent)", marginRight: 6, fontSize: 10.5 }}>⌖</span>}
        {d.title ?? (d.status === "live" ? "new desk" : d.scope)}
        {here && <span style={{ color: "var(--loki-muted)", marginLeft: 8, fontSize: 10.5, fontFamily: "var(--loki-font)" }}>· here</span>}
      </span>
      {/* Hover actions take the place of the timestamp so the row never widens. */}
      <span className="loki-tree-meta" style={{ fontSize: 10.5, color: "var(--loki-muted)", fontFamily: "var(--loki-mono)", whiteSpace: "nowrap" }}>
        {d.widgets > 0 ? `${d.widgets} · ` : ""}
        {when(d.lastActive)}
      </span>
      {(canPin || canArchive) && (
        <span className="loki-tree-actions" style={{ display: "none", gap: 2 }}>
          {canPin && (
            <button onClick={act(() => onPin!(d, !d.pinned))} title={d.pinned ? "unpin (⌘P)" : "pin to the top (⌘P)"} aria-label={d.pinned ? "unpin" : "pin"} style={{ border: "none", background: "transparent", color: d.pinned ? "var(--loki-accent)" : "var(--loki-muted)", cursor: "pointer", fontSize: 12, padding: "0 4px" }}>
              ⌖
            </button>
          )}
          {canArchive && (
            <button onClick={act(() => onArchive!(d, d.status !== "archived"))} title={d.status === "archived" ? "restore from the archive (⌘E)" : "archive (⌘E)"} aria-label={d.status === "archived" ? "restore" : "archive"} style={{ border: "none", background: "transparent", color: "var(--loki-muted)", cursor: "pointer", fontSize: 12, padding: "0 4px" }}>
              {d.status === "archived" ? "↶" : "⊟"}
            </button>
          )}
        </span>
      )}
    </div>
  );
}

function NewRow({ index, selected, onHover, onChoose, label }: { index: number; selected: number; onHover: (i: number) => void; onChoose: () => void; label: React.ReactNode }) {
  return (
    <div
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
