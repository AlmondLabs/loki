import { useEffect, useMemo, useRef, useState } from "react";
import { AgentChip } from "../desk/AgentChip";
import type { DeskSummary } from "../desk/useDesk";
import { btn, kbd } from "../chat/ui";
import { PRIORITY_LABEL, ago, columnsOf, filterTasks, type ColumnId, type Task } from "./model";
import { registerActions, typingIn } from "../shell/keymap";

/**
 * The board: four columns of tasks for later. Select (X, click, ⇧-click for a range), then ⏎ assigns
 * the selection to a desk and ⌘⏎ dispatches it (assign, then post the tasks so the agent starts now).
 * D closes as done, B toggles blocked, N or + files a new task without an agent, / filters.
 */
export function Board({
  tasks,
  loading,
  error,
  desks,
  onRefresh,
  onAssign,
  onClose,
  onStatus,
  onNew,
  active,
}: {
  tasks: Task[] | null;
  loading: boolean;
  error: string | null;
  desks: DeskSummary[];
  onRefresh: () => void;
  /** ids, and whether to dispatch (start now) rather than just assign. */
  onAssign: (ids: string[], start: boolean) => void;
  onClose: (ids: string[]) => void;
  onStatus: (ids: string[], status: "open" | "blocked") => void;
  onNew: () => void;
  /** The board is the showing segment: keys apply. */
  active: boolean;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<string | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  const columns = useMemo(() => columnsOf(filterTasks(tasks ?? [], query)), [tasks, query]);
  const all = useMemo(() => columns.flatMap((c) => c.tasks), [columns]);
  const byId = useMemo(() => new Map(all.map((t) => [t.id, t])), [all]);
  const deskTitle = useMemo(() => new Map(desks.map((d) => [d.scope, d.title ?? d.scope])), [desks]);

  // Selection and cursor follow the data: a task that left the board leaves both.
  useEffect(() => {
    setSelected((s) => new Set([...s].filter((id) => byId.has(id))));
    if (cursor && !byId.has(cursor)) setCursor(all[0]?.id ?? null);
    if (!cursor && all[0]) setCursor(all[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byId]);

  /** The tasks an action applies to: the selection, else the task under the cursor. */
  const targets = (): string[] => (selected.size ? [...selected] : cursor ? [cursor] : []);
  const actionable = (ids: string[]) => ids.filter((id) => byId.get(id)?.status !== "closed");

  const toggle = (id: string, range = false) => {
    setSelected((s) => {
      const next = new Set(s);
      if (range && anchor) {
        const col = columns.find((c) => c.tasks.some((t) => t.id === anchor) && c.tasks.some((t) => t.id === id));
        if (col) {
          const ids = col.tasks.map((t) => t.id);
          const [a, b] = [ids.indexOf(anchor), ids.indexOf(id)].sort((x, y) => x - y);
          for (const x of ids.slice(a, b + 1)) next.add(x);
          return next;
        }
      }
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setAnchor(id);
    setCursor(id);
  };

  const move = (dir: "up" | "down" | "left" | "right") => {
    if (!cursor) return setCursor(all[0]?.id ?? null);
    const ci = columns.findIndex((c) => c.tasks.some((t) => t.id === cursor));
    if (ci < 0) return;
    const col = columns[ci];
    const i = col.tasks.findIndex((t) => t.id === cursor);
    if (dir === "up" || dir === "down") {
      const next = col.tasks[Math.max(0, Math.min(col.tasks.length - 1, i + (dir === "down" ? 1 : -1)))];
      if (next) setCursor(next.id);
      return;
    }
    // Sideways: the nearest non-empty column, same row or the last one there.
    let j = ci;
    do j += dir === "right" ? 1 : -1;
    while (j >= 0 && j < columns.length && columns[j].tasks.length === 0);
    const target = columns[j];
    if (target) setCursor(target.tasks[Math.min(i, target.tasks.length - 1)].id);
  };

  // The board's actions, by keymap id. Nothing here has focus by default, so plain keys work; the shell dispatches.
  useEffect(() => {
    if (!active) return;
    return registerActions({
      "board.up": () => move("up"),
      "board.down": () => move("down"),
      "board.left": () => move("left"),
      "board.right": () => move("right"),
      "board.select": () => {
        if (cursor) toggle(cursor, false);
      },
      "board.selectRange": () => {
        if (cursor) toggle(cursor, true);
      },
      "board.assign": () => {
        const ids = actionable(targets());
        if (ids.length) onAssign(ids, false);
      },
      "board.dispatch": () => {
        const ids = actionable(targets());
        if (ids.length) onAssign(ids, true);
      },
      "board.done": () => {
        const ids = actionable(targets());
        if (ids.length) onClose(ids);
      },
      "board.blocked": () => {
        const ids = actionable(targets());
        if (!ids.length) return;
        const blocked = ids.every((id) => byId.get(id)?.status === "blocked");
        onStatus(ids, blocked ? "open" : "blocked");
      },
      "board.filter": () => filterRef.current?.focus(),
      "board.refresh": () => onRefresh(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, cursor, selected, columns, anchor]);
  // Esc: out of the filter box, else clear the selection.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (typingIn(e)) return void (e.target as HTMLElement).blur();
      if (selected.size) {
        e.preventDefault();
        setSelected(new Set());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, selected]);

  const openCount = tasks?.filter((t) => t.status !== "closed").length ?? 0;
  const sel = actionable([...selected]);

  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", background: "var(--loki-bg)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 24px 10px", borderBottom: "1px solid var(--loki-border)" }}>
        <input
          ref={filterRef}
          type="search"
          name="board-filter"
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          data-form-type="other"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="filter tasks…  /"
          aria-label="filter tasks"
          style={{ width: 280, padding: "7px 10px", fontSize: 13, background: "var(--loki-panel)", border: "1px solid var(--loki-border)", borderRadius: 8, color: "var(--loki-fg)", outline: "none" }}
        />
        <span className="loki-label" style={{ fontSize: 9.5 }}>
          {tasks === null ? (loading ? "loading the board…" : "") : `${openCount} open`}
          {loading && tasks !== null ? " · refreshing" : ""}
        </span>
        {error && <span style={{ fontSize: 12, color: "var(--loki-negative)", fontFamily: "var(--loki-mono)" }}>{error}</span>}
        <span style={{ flex: 1 }} />
        <button onClick={onNew} style={btn("var(--loki-accent)")} title="file a task yourself (⌘T)">
          + task <kbd style={kbd}>⌘T</kbd>
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "repeat(4, minmax(220px, 1fr))", gap: 14, padding: "14px 24px", overflowX: "auto" }}>
        {columns.map((col) => (
          <section key={col.id} aria-label={col.label} style={{ display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0 }}>
            <header className="loki-label" style={{ display: "flex", justifyContent: "space-between", padding: "0 4px 8px", fontSize: 9.5, color: col.id === "done" ? "var(--loki-muted)" : "var(--loki-fg)" }}>
              <span>{col.label}</span>
              <span style={{ fontFamily: "var(--loki-mono)", letterSpacing: 0 }}>{col.tasks.length || ""}</span>
            </header>
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "grid", alignContent: "start", gap: 8, paddingBottom: 8 }}>
              {col.tasks.map((t) => (
                <TaskCard key={t.id} task={t} column={col.id} selected={selected.has(t.id)} focused={cursor === t.id} assignedTitle={t.metadata.assignedDesk ? deskTitle.get(t.metadata.assignedDesk) ?? t.metadata.assignedDesk : null} onClick={(e) => toggle(t.id, e.shiftKey)} />
              ))}
              {col.tasks.length === 0 && tasks !== null && <div style={{ fontSize: 12, color: "var(--loki-muted)", padding: "10px 6px" }}>{col.id === "open" && !query ? "nothing waiting — ask an agent to park something, or press ⌘T" : "—"}</div>}
            </div>
          </section>
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 24px 12px", borderTop: "1px solid var(--loki-border)", fontSize: 12, color: "var(--loki-muted)" }}>
        {sel.length > 0 ? (
          <>
            <span style={{ color: "var(--loki-fg)" }}>{sel.length} selected</span>
            <button onClick={() => onAssign(sel, false)} style={btn("var(--loki-fg)")}>assign to a desk <kbd style={kbd}>↵</kbd></button>
            <button onClick={() => onAssign(sel, true)} style={btn("var(--loki-accent)")}>dispatch now <kbd style={kbd}>⌘↵</kbd></button>
            <button onClick={() => onClose(sel)} style={btn("var(--loki-positive)")}>done <kbd style={kbd}>⌫</kbd></button>
            <button onClick={() => setSelected(new Set())} style={btn()}>clear <kbd style={kbd}>esc</kbd></button>
          </>
        ) : (
          <span style={{ fontFamily: "var(--loki-mono)", fontSize: 10.5, letterSpacing: "0.06em" }}>↑↓←→ move · X select · ⇧X range · ↵ assign · ⌘↵ dispatch · ⌫ done · ⇧⌫ blocked · ⌘T new · ⌘R refresh · / filter</span>
        )}
      </div>
    </div>
  );
}

function TaskCard({ task: t, column, selected, focused, assignedTitle, onClick }: { task: Task; column: ColumnId; selected: boolean; focused: boolean; assignedTitle: string | null; onClick: (e: React.MouseEvent) => void }) {
  const urgent = t.priority <= 1 && column !== "done";
  return (
    <div
      role="option"
      aria-selected={selected}
      data-focused={focused || undefined}
      onClick={onClick}
      style={{
        background: selected ? "var(--loki-accent-soft)" : "var(--loki-panel)",
        border: `1px solid ${focused ? "var(--loki-accent)" : selected ? "var(--loki-accent-soft)" : "var(--loki-border)"}`,
        borderRadius: 10,
        padding: "10px 12px",
        cursor: "pointer",
        opacity: column === "done" ? 0.6 : 1,
        display: "grid",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <span aria-hidden style={{ width: 12, height: 12, marginTop: 3, borderRadius: 3, border: `1px solid ${selected ? "var(--loki-accent)" : "var(--loki-border)"}`, background: selected ? "var(--loki-accent)" : "transparent", flex: "0 0 auto" }} />
        <span style={{ fontFamily: "var(--loki-display)", fontSize: 14, lineHeight: 1.3, color: "var(--loki-fg)", textDecoration: column === "done" ? "line-through" : undefined, minWidth: 0, overflowWrap: "anywhere" }}>{t.title}</span>
      </div>
      {t.description && column !== "done" && <div style={{ fontSize: 12, color: "var(--loki-muted)", lineHeight: 1.45, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{t.description}</div>}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 10.5, fontFamily: "var(--loki-mono)", color: "var(--loki-muted)" }}>
        <span style={{ color: urgent ? "var(--loki-accent)" : undefined }}>{PRIORITY_LABEL[t.priority] ?? "P2"}</span>
        <span>{t.id}</span>
        {t.metadata.agent ? <AgentChip name={t.metadata.agent} size={9} /> : t.metadata.by === "you" ? <span>you</span> : null}
        {t.labels.map((l) => (
          <span key={l} style={{ padding: "1px 6px", border: "1px solid var(--loki-border)", borderRadius: 999 }}>{l}</span>
        ))}
        <span style={{ marginLeft: "auto" }}>{ago(column === "done" ? t.closedAt : t.updatedAt)}</span>
      </div>
      {assignedTitle && column !== "done" && (
        <div style={{ fontSize: 11, color: "var(--loki-accent)", display: "flex", alignItems: "center", gap: 6 }}>
          <span aria-hidden>→</span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{assignedTitle}</span>
          {t.assignee && <AgentChip name={t.assignee} size={9} />}
        </div>
      )}
    </div>
  );
}
