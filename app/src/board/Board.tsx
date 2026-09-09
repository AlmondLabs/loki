import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AgentChip } from "../desk/AgentChip";
import type { DeskSummary } from "../desk/useDesk";
import { Button, Chip, Field } from "../ui";
import { PRIORITY_LABEL, ago, columnsOf, filterTasks, type ColumnId, type Task } from "./model";
import { registerActions, typingIn } from "../shell/keymap";

/**
 * The board: four columns of tasks for later. Select (X, click, ⇧-click for a range), then ⏎ assigns
 * the selection to a desk and ⌘⏎ dispatches it (assign, then post the tasks so the agent starts now).
 * D closes as done, B toggles blocked, N or + files a new task without an agent, / filters.
 *
 * Each column is a listbox; the cursor card is the one Tab stop (roving tabindex) and the arrows,
 * space and shift-arrows work on the focused card too, so the board reads and works from a keyboard
 * or a screen reader. The keymap's plain keys keep firing: a focused card is not a text box.
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
  const [selectedRaw, setSelected] = useState<Set<string>>(new Set());
  const [cursorRaw, setCursor] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<string | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  /** Set by a keyboard move: the next render focuses the cursor card. Data changes never steal focus. */
  const focusCursor = useRef(false);

  const columns = useMemo(() => columnsOf(filterTasks(tasks ?? [], query)), [tasks, query]);
  const all = useMemo(() => columns.flatMap((c) => c.tasks), [columns]);
  const byId = useMemo(() => new Map(all.map((t) => [t.id, t])), [all]);
  const deskTitle = useMemo(() => new Map(desks.map((d) => [d.scope, d.title ?? d.scope])), [desks]);

  // Selection and cursor follow the data, read against it at render: a task that left the board leaves both,
  // and the cursor lands on the first card when it has nowhere else to be.
  const cursor = cursorRaw && byId.has(cursorRaw) ? cursorRaw : (all[0]?.id ?? null);
  const selected = useMemo(() => ([...selectedRaw].every((id) => byId.has(id)) ? selectedRaw : new Set([...selectedRaw].filter((id) => byId.has(id)))), [selectedRaw, byId]);

  // The cursor moved by keyboard: focus follows it, and the column scrolls just enough to show it.
  useEffect(() => {
    if (!focusCursor.current || !cursor) return;
    focusCursor.current = false;
    const el = gridRef.current?.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(cursor)}"]`);
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "nearest" });
  }, [cursor]);

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

  type Dir = "up" | "down" | "left" | "right";

  /** The card the cursor would land on, or null when there is nowhere to go. */
  const nextOf = (dir: Dir): string | null => {
    if (!cursor) return all[0]?.id ?? null;
    const ci = columns.findIndex((c) => c.tasks.some((t) => t.id === cursor));
    if (ci < 0) return null;
    const col = columns[ci];
    const i = col.tasks.findIndex((t) => t.id === cursor);
    if (dir === "up" || dir === "down") {
      const next = col.tasks[Math.max(0, Math.min(col.tasks.length - 1, i + (dir === "down" ? 1 : -1)))];
      return next && next.id !== cursor ? next.id : null;
    }
    // Sideways: the nearest non-empty column, same row or the last one there.
    let j = ci;
    do j += dir === "right" ? 1 : -1;
    while (j >= 0 && j < columns.length && columns[j].tasks.length === 0);
    const target = columns[j];
    return target ? target.tasks[Math.min(i, target.tasks.length - 1)].id : null;
  };

  const move = (dir: Dir) => {
    const next = nextOf(dir);
    if (!next) return;
    focusCursor.current = true;
    setCursor(next);
  };

  /**
   * Shift-arrow: move and select what was passed over. Within a column the anchor stays put, so the
   * range is anchor…cursor as in a shift-click; across columns the card landed on joins the selection.
   */
  const extend = (dir: Dir) => {
    const next = nextOf(dir);
    if (!next || !cursor) return;
    const col = columns.find((c) => c.tasks.some((t) => t.id === next));
    const from = anchor && col?.tasks.some((t) => t.id === anchor) ? anchor : cursor;
    setSelected((s) => {
      const nextSel = new Set(s);
      if (col?.tasks.some((t) => t.id === from)) {
        const ids = col.tasks.map((t) => t.id);
        const [a, b] = [ids.indexOf(from), ids.indexOf(next)].sort((x, y) => x - y);
        for (const x of ids.slice(a, b + 1)) nextSel.add(x);
      } else nextSel.add(next);
      return nextSel;
    });
    setAnchor(from);
    focusCursor.current = true;
    setCursor(next);
  };

  /**
   * Keys on a focused card. Handled keys stop here so the shell's keymap does not move the cursor a
   * second time; everything else (X, ⏎, ⌫, /, the chords) bubbles to the keymap as before.
   */
  const onCardKey = (e: React.KeyboardEvent) => {
    const dir: Dir | null = e.key === "ArrowUp" ? "up" : e.key === "ArrowDown" ? "down" : e.key === "ArrowLeft" ? "left" : e.key === "ArrowRight" ? "right" : null;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (dir) {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) extend(dir);
      else move(dir);
      return;
    }
    if (e.key === " " && cursor) {
      e.preventDefault();
      e.stopPropagation();
      toggle(cursor, e.shiftKey);
    }
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
        <Field
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
          style={{ width: 280 }}
        />
        <span className="loki-label" style={{ fontSize: 9.5 }}>
          {tasks === null ? (loading ? "loading the board…" : "") : `${openCount} open`}
          {loading && tasks !== null ? " · refreshing" : ""}
        </span>
        {error && <span style={{ fontSize: 12, color: "var(--loki-negative)", fontFamily: "var(--loki-mono)" }}>{error}</span>}
        <span style={{ flex: 1 }} />
        <Button size="md" tone="brass" kbd="⌘T" onClick={onNew} title="file a task yourself (⌘T)">
          + task
        </Button>
      </div>

      <div ref={gridRef} style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "repeat(4, minmax(220px, 1fr))", gap: 14, padding: "14px 24px", overflowX: "auto" }}>
        {columns.map((col) => (
          <section key={col.id} aria-label={col.label} style={{ display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0 }}>
            <header className="loki-label" style={{ display: "flex", justifyContent: "space-between", padding: "0 4px 8px", fontSize: 9.5, color: col.id === "done" ? "var(--loki-muted)" : "var(--loki-fg)" }}>
              <span>{col.label}</span>
              <span style={{ fontFamily: "var(--loki-mono)", letterSpacing: 0 }}>{col.tasks.length || ""}</span>
            </header>
            {col.tasks.length > 0 ? (
              <div role="listbox" aria-label={col.label} aria-multiselectable="true" style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "grid", alignContent: "start", gap: 8, paddingBottom: 8 }}>
                {col.tasks.map((t) => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    column={col.id}
                    selected={selected.has(t.id)}
                    focused={cursor === t.id}
                    // Roving tabindex: the cursor card is the Tab stop; before there is one, the first card is.
                    tabIndex={cursor ? (cursor === t.id ? 0 : -1) : t.id === all[0]?.id ? 0 : -1}
                    assignedTitle={t.metadata.assignedDesk ? deskTitle.get(t.metadata.assignedDesk) ?? t.metadata.assignedDesk : null}
                    onClick={(e) => toggle(t.id, e.shiftKey)}
                    onFocus={() => cursor !== t.id && setCursor(t.id)}
                    onKeyDown={onCardKey}
                  />
                ))}
              </div>
            ) : (
              tasks !== null && (
                <p role="status" style={{ margin: 0, fontSize: 12, color: "var(--loki-muted)", padding: "10px 6px" }}>
                  {emptyLine(col.id, query)}
                </p>
              )
            )}
          </section>
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 24px 12px", borderTop: "1px solid var(--loki-border)", fontSize: 12, color: "var(--loki-muted)" }}>
        {sel.length > 0 ? (
          <>
            <span style={{ color: "var(--loki-fg)" }}>{sel.length} selected</span>
            <Button size="sm" tone="paper" kbd="↵" onClick={() => onAssign(sel, false)}>assign to a desk</Button>
            <Button size="sm" tone="brass" kbd="⌘↵" onClick={() => onAssign(sel, true)}>dispatch now</Button>
            <Button size="sm" tone="positive" kbd="⌫" onClick={() => onClose(sel)}>done</Button>
            <Button size="sm" kbd="esc" onClick={() => setSelected(new Set())}>clear</Button>
          </>
        ) : (
          <span style={{ fontFamily: "var(--loki-mono)", fontSize: 10.5, letterSpacing: "0.06em" }}>↑↓←→ move · X select · ⇧X range · ↵ assign · ⌘↵ dispatch · ⌫ done · ⇧⌫ blocked · ⌘T new · ⌘R refresh · / filter</span>
        )}
      </div>
    </div>
  );
}

/** What an empty column says for itself. */
function emptyLine(id: ColumnId, query: string): string {
  if (query.trim()) return "no matches";
  switch (id) {
    case "open":
      return "nothing waiting — ask an agent to park something, or press ⌘T";
    case "in_progress":
      return "nothing in progress";
    case "blocked":
      return "nothing blocked";
    case "done":
      return "nothing done in 7 days";
  }
}

function TaskCard({
  task: t,
  column,
  selected,
  focused,
  tabIndex,
  assignedTitle,
  onClick,
  onFocus,
  onKeyDown,
}: {
  task: Task;
  column: ColumnId;
  selected: boolean;
  focused: boolean;
  tabIndex: 0 | -1;
  assignedTitle: string | null;
  onClick: (e: React.MouseEvent) => void;
  onFocus: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}) {
  const uid = useId();
  const showDesc = !!t.description && column !== "done";
  const showAssigned = !!assignedTitle && column !== "done";
  // The name is the title; the rest of the card describes it.
  const describedBy = [showDesc && `${uid}-desc`, `${uid}-meta`, showAssigned && `${uid}-to`].filter(Boolean).join(" ");
  return (
    <div
      role="option"
      aria-selected={selected}
      aria-label={t.title}
      aria-describedby={describedBy}
      tabIndex={tabIndex}
      data-task-id={t.id}
      data-focused={focused || undefined}
      onClick={onClick}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      style={{
        background: selected ? "var(--loki-accent-soft)" : "var(--loki-panel)",
        border: `1px solid ${focused ? "var(--loki-accent)" : selected ? "var(--loki-accent-soft)" : "var(--loki-border)"}`,
        borderRadius: 12,
        padding: "10px 12px",
        cursor: "pointer",
        display: "grid",
        gap: 6,
      }}
    >
      <TaskTitle task={t} column={column} selected={selected} />
      {showDesc && <div id={`${uid}-desc`} style={{ fontSize: 12, color: "var(--loki-muted)", lineHeight: 1.45, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{t.description}</div>}
      <TaskMeta id={`${uid}-meta`} task={t} column={column} />
      {showAssigned && <AssignedLine id={`${uid}-to`} task={t} title={assignedTitle!} />}
    </div>
  );
}

/** The card's first row: the selection box and the title, struck through once the task is done. */
function TaskTitle({ task: t, column, selected }: { task: Task; column: ColumnId; selected: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
      <span aria-hidden style={{ width: 12, height: 12, marginTop: 3, borderRadius: 3, border: `1px solid ${selected ? "var(--loki-accent)" : "var(--loki-border)"}`, background: selected ? "var(--loki-accent)" : "transparent", flex: "0 0 auto" }} />
      <span style={{ fontFamily: "var(--loki-display)", fontSize: 13.5, lineHeight: 1.3, color: column === "done" ? "var(--loki-muted)" : "var(--loki-fg)", textDecoration: column === "done" ? "line-through" : undefined, minWidth: 0, overflowWrap: "anywhere" }}>{t.title}</span>
    </div>
  );
}

/** The meta line: priority (brass when urgent), id, who filed it, labels, and when it last moved. */
function TaskMeta({ id, task: t, column }: { id: string; task: Task; column: ColumnId }) {
  const urgent = t.priority <= 1 && column !== "done";
  return (
    <div id={id} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 10.5, fontFamily: "var(--loki-mono)", color: "var(--loki-muted)" }}>
      <span style={{ color: urgent ? "var(--loki-accent)" : undefined }}>{PRIORITY_LABEL[t.priority] ?? "P2"}</span>
      <span>{t.id}</span>
      {t.metadata.agent ? <AgentChip name={t.metadata.agent} size={9.5} /> : t.metadata.by === "you" ? <span>you</span> : null}
      {t.labels.map((l) => (
        <Chip key={l} static tag>{l}</Chip>
      ))}
      <span style={{ marginLeft: "auto" }}>{ago(column === "done" ? t.closedAt : t.updatedAt)}</span>
    </div>
  );
}

/** Where the task is going: the desk's title and, when known, the agent that has it. */
function AssignedLine({ id, task: t, title }: { id: string; task: Task; title: string }) {
  return (
    <div id={id} style={{ fontSize: 10.5, color: "var(--loki-accent)", display: "flex", alignItems: "center", gap: 6 }}>
      <span aria-hidden>→</span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
      {t.assignee && <AgentChip name={t.assignee} size={9.5} />}
    </div>
  );
}
