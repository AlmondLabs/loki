import { useEffect, useMemo, useRef, useState } from "react";
import type { Scope } from "../../../shared/desk-core.ts";
import type { AttentionItem } from "../attention/model";
import type { DeskSummary } from "../desk/useDesk";
import { AgentChip } from "../desk/AgentChip";

export const TREE_WIDTH = 320;

type Row = { kind: "desk"; desk: DeskSummary } | { kind: "new"; agentId: string | null; agentName: string | null; name: string };

/**
 * The desks tree: a drawer over the sheet, desks grouped by the agent that drew them,
 * "new desk" at the foot of each group. Type to filter, ↑↓ move, ↵ switch, esc close.
 * Archived and deleted conversations sit under a folded "archive" group at the bottom.
 * Each desk carries the same attention mark the inbox would give it.
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
}: {
  open: boolean;
  onClose: () => void;
  desks: DeskSummary[];
  /** Agents the app-server knows; an agent with no desk yet still gets a group with "new desk". */
  agents: Array<{ id: string; name: string }>;
  items: AttentionItem[];
  current: Scope;
  onSwitch: (scope: Scope) => void;
  /** Start a new desk for this agent (null: pick in the sheet); `name` when typed into the filter. */
  onNew?: (agentId: string | null, name: string) => void;
  /** Picker mode: a heading above the filter, and choosing a desk calls this instead of switching to it. */
  heading?: string | null;
  onPickDesk?: (desk: DeskSummary) => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [showArchive, setShowArchive] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const keyboardMove = useRef(false);

  const marks = useMemo(() => {
    const m = new Map<string, AttentionItem>();
    for (const i of items) m.set(`${i.agentId}/${i.id}`, i);
    return m;
  }, [items]);

  const q = query.trim().toLowerCase();
  const matches = (d: DeskSummary) => !q || (d.title ?? "").toLowerCase().includes(q) || d.scope.toLowerCase().includes(q) || (d.agentName ?? "").toLowerCase().includes(q);

  /** Groups in agent order (agents the server lists first, then any agent only the desks know), then the archive. */
  const groups = useMemo(() => {
    const live = desks.filter((d) => d.status === "live" && matches(d));
    const byAgent = new Map<string, { agentId: string | null; agentName: string | null; desks: DeskSummary[] }>();
    for (const a of agents) byAgent.set(a.id, { agentId: a.id, agentName: a.name, desks: [] });
    for (const d of live) {
      const key = d.agentId ?? d.agentName ?? "—";
      if (!byAgent.has(key)) byAgent.set(key, { agentId: d.agentId, agentName: d.agentName, desks: [] });
      byAgent.get(key)!.desks.push(d);
    }
    const list = [...byAgent.values()].filter((g) => g.desks.length > 0 || !q);
    const archive = desks.filter((d) => d.status !== "live" && matches(d));
    return { list, archive };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desks, agents, q]);

  /** Every row the arrows can land on, in display order. */
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const g of groups.list) {
      for (const d of g.desks) out.push({ kind: "desk", desk: d });
      if (onNew && (!q || g.desks.length === 0)) out.push({ kind: "new", agentId: g.agentId, agentName: g.agentName, name: "" });
    }
    if (q && rows_live_count(groups.list) === 0 && onNew) out.push({ kind: "new", agentId: null, agentName: null, name: query.trim() });
    if (showArchive || q) for (const d of groups.archive) out.push({ kind: "desk", desk: d });
    return out;
  }, [groups, q, query, showArchive, onNew]);

  useEffect(() => {
    if (open) {
      setQuery("");
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

  let cursor = 0;
  const rowIndex = () => cursor++;

  return (
    <div
      onPointerDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
      style={{ position: "absolute", inset: 0, background: "rgba(8,8,10,0.35)", zIndex: 200000 }}
    >
      <div
        role="dialog"
        data-tree
        aria-label="desks"
        className="loki-drawer"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          bottom: 0,
          width: TREE_WIDTH,
          maxWidth: "85vw",
          background: "var(--loki-panel)",
          borderRight: "1px solid var(--loki-border)",
          boxShadow: "18px 0 60px rgba(0,0,0,0.5)",
          display: "flex",
          flexDirection: "column",
        }}
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
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(rows[index]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          placeholder="find a desk…"
          aria-label="find a desk"
          style={{ width: "100%", boxSizing: "border-box", padding: "13px 16px", fontSize: 14, background: "transparent", border: "none", borderBottom: "1px solid var(--loki-border)", color: "var(--loki-fg)", outline: "none" }}
        />
        <div ref={listRef} role="listbox" aria-label="desks" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "6px 8px 12px" }}>
          {groups.list.map((g) => (
            <div key={g.agentId ?? g.agentName ?? "—"} style={{ marginTop: 10 }}>
              <div className="loki-label" style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px", fontSize: 9.5 }}>
                <AgentChip name={g.agentName} size={10} />
                {!g.agentName && <span>unknown agent</span>}
                <span style={{ color: "var(--loki-muted)", marginLeft: "auto", fontFamily: "var(--loki-mono)", letterSpacing: 0 }}>{g.desks.length || ""}</span>
              </div>
              {g.desks.map((d) => (
                <DeskRow key={d.scope} desk={d} mark={marks.get(`${d.agentId}/${d.conversationId}`)} here={d.scope === current} index={rowIndex()} selected={index} onHover={setIndex} onChoose={() => choose({ kind: "desk", desk: d })} />
              ))}
              {onNew && (!q || g.desks.length === 0) && (
                <NewRow index={rowIndex()} selected={index} onHover={setIndex} onChoose={() => choose({ kind: "new", agentId: g.agentId, agentName: g.agentName, name: "" })} label="new desk" />
              )}
            </div>
          ))}
          {q && rows_live_count(groups.list) === 0 && onNew && (
            <div style={{ marginTop: 10 }}>
              <NewRow index={rowIndex()} selected={index} onHover={setIndex} onChoose={() => choose({ kind: "new", agentId: null, agentName: null, name: query.trim() })} label={<>create desk <span style={{ fontFamily: "var(--loki-display)" }}>“{query.trim()}”</span></>} />
            </div>
          )}
          {groups.archive.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <button
                onClick={() => setShowArchive((v) => !v)}
                className="loki-label"
                aria-expanded={showArchive || !!q}
                style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "4px 8px", border: "none", background: "transparent", color: "var(--loki-muted)", cursor: "pointer", fontSize: 9.5, textAlign: "left" }}
              >
                <span style={{ display: "inline-block", transform: showArchive || q ? "rotate(90deg)" : "none", transition: "transform 120ms" }}>▸</span>
                archive
                <span style={{ marginLeft: "auto", fontFamily: "var(--loki-mono)", letterSpacing: 0 }}>{groups.archive.length}</span>
              </button>
              {(showArchive || q) && groups.archive.map((d) => <DeskRow key={d.scope} desk={d} mark={undefined} here={d.scope === current} index={rowIndex()} selected={index} onHover={setIndex} onChoose={() => choose({ kind: "desk", desk: d })} />)}
            </div>
          )}
          {rows.length === 0 && <div style={{ padding: 14, fontSize: 12, color: "var(--loki-muted)" }}>no desks match</div>}
        </div>
        <div style={{ padding: "6px 14px", fontSize: 10, color: "var(--loki-muted)", borderTop: "1px solid var(--loki-border)", letterSpacing: "0.06em", fontFamily: "var(--loki-mono)" }}>{onPickDesk ? "↑↓ move · ↵ choose · esc cancel" : "↑↓ move · ↵ open · esc close"}</div>
      </div>
    </div>
  );
}

function rows_live_count(list: Array<{ desks: DeskSummary[] }>): number {
  return list.reduce((n, g) => n + g.desks.length, 0);
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

function DeskRow({ desk: d, mark, here, index, selected, onHover, onChoose }: { desk: DeskSummary; mark: AttentionItem | undefined; here: boolean; index: number; selected: number; onHover: (i: number) => void; onChoose: () => void }) {
  return (
    <div
      role="option"
      data-index={index}
      aria-selected={index === selected}
      onMouseEnter={() => onHover(index)}
      onClick={onChoose}
      style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 10px", borderRadius: 8, cursor: "pointer", background: index === selected ? "var(--loki-accent-soft)" : "transparent", opacity: d.status === "live" ? 1 : 0.7 }}
    >
      <Mark item={mark} status={d.status} />
      <span style={{ flex: 1, minWidth: 0, fontFamily: "var(--loki-display)", fontSize: 14, color: "var(--loki-fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {d.title ?? (d.status === "live" ? "new desk" : d.scope)}
        {here && <span style={{ color: "var(--loki-muted)", marginLeft: 8, fontSize: 11, fontFamily: "var(--loki-font)" }}>· here</span>}
      </span>
      <span style={{ fontSize: 10.5, color: "var(--loki-muted)", fontFamily: "var(--loki-mono)", whiteSpace: "nowrap" }}>
        {d.widgets > 0 ? `${d.widgets} · ` : ""}
        {when(d.lastActive)}
      </span>
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
      style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 10px", borderRadius: 8, cursor: "pointer", background: index === selected ? "var(--loki-accent-soft)" : "transparent", color: "var(--loki-muted)", fontSize: 12.5 }}
    >
      <span style={{ width: 7, textAlign: "center", color: "var(--loki-accent)", fontSize: 14, lineHeight: 1 }}>+</span>
      <span>{label}</span>
    </div>
  );
}
