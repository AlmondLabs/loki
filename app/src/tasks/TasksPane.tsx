import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AgentChip, AgentFace } from "../desk/AgentChip";

import { Button, Chip, Field, ListIcon, ListRow, ListSection } from "../components";
import { ago } from "../shared/ago";
import { taskSource } from "../../../core/task-source.ts";
import {
  PRIORITY_LABEL,
  STATUS_LABEL,
  boardColumns,
  cellText,
  columnOf,
  filterTasks,
  filedBy,
  folderName,
  isWaiting,
  missingAgentLine,
  nextSort,
  resolveTaskView,
  stepCursor,
  tableRows,
  taskViews,
  viewTasks,
  type Column,
  type ColumnId,
  type Dir,
  type GroupBy,
  type SortKey,
  type TaskViewId,
} from "./model";
import { useTaskView, useViewPrefs } from "./useTaskView";
import { keyFor, registerActions, typingIn } from "../shell/keymap";
import type { DeskSummary, Task } from "../../../core/frame-types.ts";

const GROUPS: Array<[GroupBy, string]> = [
  ["status", "Status"],
  ["assignee", "Assignee"],
  ["folder", "Folder"],
];
const TABLE_COLUMNS: Array<[SortKey, string]> = [
  ["title", "Title"],
  ["status", "Status"],
  ["assignee", "Assignee"],
  ["by", "Filed by"],
  ["chat", "From chat"],
  ["folder", "Folder"],
  ["updated", "Updated"],
];
const TABLE_GRID = "minmax(220px, 2.4fr) 104px minmax(90px, 1fr) minmax(80px, 0.8fr) minmax(110px, 1.2fr) minmax(90px, 1fr) 64px";

/**
 * Tasks: the shared task list, as the view chosen in the sidebar (useTaskView) lays it out. Board shows columns by
 * status, assignee or folder; Table shows rows sorted by any column (useViewPrefs keeps both per view). The keys are
 * the same either way: select (X, click, ⇧-click for a range), then ⏎ assigns the selection to a chat and ⌘⏎
 * dispatches it (assign, then post the tasks so the agent starts now). ⌫ is done, ⇧⌫ blocked, / filters, L switches
 * the layout, G the Board's grouping. A task an agent says is done waits for you: ⌫ confirms it, R reopens it.
 *
 * Each column (and the Table) is a listbox; the cursor card is the one Tab stop (roving tabindex) and the arrows,
 * space and shift-arrows work on the focused card too, so the list reads and works from a keyboard or a screen
 * reader. The keymap's plain keys keep firing: a focused card is not a text box.
 */
export function TasksPane({
  tasks,
  loading,
  error,
  desks,
  onRefresh,
  onAssign,
  onClose,
  onReopen,
  onStatus,
  onNew,
  focusId = null,
  onOpenSource,
  active,
}: {
  tasks: Task[] | null;
  loading: boolean;
  error: string | null;
  desks: DeskSummary[];
  onRefresh: () => void;
  /** ids, and whether to dispatch (start now) rather than just assign. */
  onAssign: (ids: string[], start: boolean) => void;
  /** Done: closes them; for a task an agent said was done, this is the person's confirmation. */
  onClose: (ids: string[]) => void;
  /** Not done after all: an agent's done? taken back, or a done task opened again. */
  onReopen: (ids: string[]) => void;
  onStatus: (ids: string[], status: "open" | "blocked") => void;
  onNew: () => void;
  /**
   * A task to show (a message's chip was clicked): the cursor starts on it and its card takes focus once drawn. The
   * host mounts the pane afresh for each ask (a key), with the view already set to All, so nothing is adjusted after.
   */
  focusId?: string | null;
  /** A task filed from a message: open its chat at that message. */
  onOpenSource?: (task: Task) => void;
  /** Tasks is the showing segment: keys apply. */
  active: boolean;
}) {
  const [query, setQuery] = useState("");
  const [stored, setView] = useTaskView();
  // A remembered agent view with nothing left for that agent asks for a new pick; nothing is stored until one is made.
  const { view, missing } = useMemo(() => resolveTaskView(stored, tasks), [stored, tasks]);
  const [prefs, setPrefs] = useViewPrefs(view);
  const [selectedRaw, setSelected] = useState<Set<string>>(new Set());
  const [cursorRaw, setCursor] = useState<string | null>(focusId);
  const [anchor, setAnchor] = useState<string | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  /** Set by a keyboard move: the next render focuses the cursor card. Data changes never steal focus. */
  const focusCursor = useRef(false);
  const deskTitle = useMemo(() => new Map(desks.map((d) => [d.scope, d.title ?? d.scope])), [desks]);
  const chatName = (desk: string) => deskTitle.get(desk) ?? desk;

  // No cards while the picked agent is missing: the keys have nothing to act on until the new pick. The Table is one
  // column to the keys: up and down, no sideways.
  const columns = useMemo((): Column[] => {
    if (missing) return [];
    const shown = viewTasks(filterTasks(tasks ?? [], query), view);
    if (prefs.layout === "table") return [{ id: "table", label: "Tasks", tasks: tableRows(shown, prefs.sort, (d) => deskTitle.get(d) ?? d) }];
    return boardColumns(shown, prefs.groupBy);
  }, [tasks, query, view, missing, prefs.layout, prefs.groupBy, prefs.sort, deskTitle]);
  const all = useMemo(() => columns.flatMap((c) => c.tasks), [columns]);
  const byId = useMemo(() => new Map(all.map((t) => [t.id, t])), [all]);

  // Selection and cursor follow the data, read against it at render: a task that left the list leaves both,
  // and the cursor lands on the first card when it has nowhere else to be.
  const cursor = cursorRaw && byId.has(cursorRaw) ? cursorRaw : (all[0]?.id ?? null);
  const selected = useMemo(
    () => ([...selectedRaw].every((id) => byId.has(id)) ? selectedRaw : new Set([...selectedRaw].filter((id) => byId.has(id)))),
    [selectedRaw, byId],
  );

  // A message's chip asked for this task: its card takes focus once it is drawn (the list may still be loading).
  const focusTask = useRef<string | null>(focusId);
  useEffect(() => {
    const id = focusTask.current;
    if (!id) return;
    const el = gridRef.current?.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(id)}"]`);
    if (!el) return;
    focusTask.current = null;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "center" });
  });

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
  /** What Reopen can take back: an agent's done?, or a task that is done. */
  const reopenable = (ids: string[]) =>
    ids.filter((id) => {
      const t = byId.get(id);
      return !!t && (isWaiting(t) || t.status === "closed");
    });

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

  /** The card the cursor would land on, or null when there is nowhere to go (a single list has no sideways). */
  const nextOf = (dir: Dir): string | null => stepCursor(columns, cursor, dir);

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
    const dir: Dir | null =
      e.key === "ArrowUp" ? "up" : e.key === "ArrowDown" ? "down" : e.key === "ArrowLeft" ? "left" : e.key === "ArrowRight" ? "right" : null;
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

  const nextGroup = (): GroupBy => GROUPS[(GROUPS.findIndex(([g]) => g === prefs.groupBy) + 1) % GROUPS.length][0];

  // The task list's actions, by keymap id. Nothing here has focus by default, so plain keys work; the shell dispatches.
  useEffect(() => {
    if (!active) return;
    return registerActions({
      "tasks.up": () => move("up"),
      "tasks.down": () => move("down"),
      "tasks.left": () => move("left"),
      "tasks.right": () => move("right"),
      "tasks.select": () => {
        if (cursor) toggle(cursor, false);
      },
      "tasks.selectRange": () => {
        if (cursor) toggle(cursor, true);
      },
      "tasks.assign": () => {
        const ids = actionable(targets());
        if (ids.length) onAssign(ids, false);
      },
      "tasks.dispatch": () => {
        const ids = actionable(targets());
        if (ids.length) onAssign(ids, true);
      },
      "tasks.done": () => {
        const ids = actionable(targets());
        if (ids.length) onClose(ids);
      },
      "tasks.reopen": () => {
        const ids = reopenable(targets());
        if (ids.length) onReopen(ids);
      },
      "tasks.blocked": () => {
        const ids = actionable(targets());
        if (!ids.length) return;
        const blocked = ids.every((id) => byId.get(id)?.status === "blocked");
        onStatus(ids, blocked ? "open" : "blocked");
      },
      "tasks.prevColumn": () => move("left"),
      "tasks.nextColumn": () => move("right"),
      "tasks.filter": () => filterRef.current?.focus(),
      "tasks.refresh": () => onRefresh(),
      "tasks.layout": () => setPrefs({ layout: prefs.layout === "board" ? "table" : "board" }),
      "tasks.groupBy": () => {
        if (prefs.layout === "board") setPrefs({ groupBy: nextGroup() });
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, cursor, selected, columns, anchor, prefs.layout, prefs.groupBy, view]);
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
  const selReopen = reopenable([...selected]);
  const selWaiting = sel.filter((id) => isWaiting(byId.get(id)!));

  const cardProps = (t: Task) => ({
    task: t,
    selected: selected.has(t.id),
    focused: cursor === t.id,
    // Roving tabindex: the cursor card is the Tab stop; before there is one, the first card is.
    tabIndex: (cursor ? (cursor === t.id ? 0 : -1) : t.id === all[0]?.id ? 0 : -1) as 0 | -1,
    onClick: (e: React.MouseEvent) => toggle(t.id, e.shiftKey),
    onFocus: () => cursor !== t.id && setCursor(t.id),
    onKeyDown: onCardKey,
    onConfirm: () => onClose([t.id]),
    onReopen: () => onReopen([t.id]),
    onOpenSource: onOpenSource && taskSource(t) ? () => onOpenSource(t) : undefined,
  });

  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", background: "var(--loki-bg)" }}>
      <div
        style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 24px 10px", borderBottom: "1px solid var(--loki-border)", flexWrap: "wrap" }}
      >
        <Field
          ref={filterRef}
          type="search"
          name="tasks-filter"
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          data-form-type="other"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="filter tasks…  /"
          aria-label="filter tasks"
          style={{ width: 240 }}
        />
        <span className="loki-label">
          {tasks === null ? (loading ? "Loading tasks…" : "") : `${openCount} open`}
          {loading && tasks !== null ? " · refreshing" : ""}
        </span>
        {error && <span className="loki-meta loki-meta--negative loki-meta--wrap">{error}</span>}
        <span style={{ flex: 1 }} />
        <div role="group" aria-label={`Layout (${keyFor("tasks.layout")})`} style={{ display: "flex", gap: 4 }}>
          <Chip active={prefs.layout === "board"} aria-pressed={prefs.layout === "board"} onClick={() => setPrefs({ layout: "board" })}>
            Board
          </Chip>
          <Chip active={prefs.layout === "table"} aria-pressed={prefs.layout === "table"} onClick={() => setPrefs({ layout: "table" })}>
            Table
          </Chip>
        </div>
        {prefs.layout === "board" && (
          <div role="group" aria-label={`Group by (${keyFor("tasks.groupBy")})`} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span className="loki-meta" aria-hidden>
              group by
            </span>
            {GROUPS.map(([g, label]) => (
              <Chip key={g} active={prefs.groupBy === g} aria-pressed={prefs.groupBy === g} onClick={() => setPrefs({ groupBy: g })}>
                {label}
              </Chip>
            ))}
          </div>
        )}
        <Button size="md" tone="brass" kbd={keyFor("task.new")} onClick={onNew} title={`file a task yourself (${keyFor("task.new")})`}>
          + task
        </Button>
      </div>

      {missing && <MissingAgent agent={missing} tasks={tasks ?? []} onPick={setView} />}
      {!missing && prefs.layout === "table" && (
        <div ref={gridRef} style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "8px 24px 14px" }}>
          <TaskTable
            rows={columns[0]?.tasks ?? []}
            sort={prefs.sort}
            onSort={(key) => setPrefs({ sort: nextSort(prefs.sort, key) })}
            chatName={chatName}
            empty={tasks !== null ? emptyView(view, query) : null}
            card={cardProps}
          />
        </div>
      )}
      {/* 168px columns: the four fit beside the list column in a 1100-wide window (1100 − rail − 260) without scrolling sideways. */}
      {!missing && prefs.layout === "board" && (
        <div
          ref={gridRef}
          style={{
            flex: 1,
            minHeight: 0,
            display: "grid",
            gridTemplateColumns: columns.length > 1 && all.length > 0 ? `repeat(${columns.length}, minmax(168px, 1fr))` : "minmax(220px, 760px)",
            gap: 14,
            padding: "14px 24px",
            overflowX: "auto",
          }}
        >
          {all.length === 0 && tasks !== null && (
            <p role="status" className="loki-meta loki-meta--wrap" style={{ margin: 0, padding: "10px 6px" }}>
              {emptyView(view, query)}
            </p>
          )}
          {/* A view with nothing in it says so once, in its own words, rather than four empty columns. */}
          {all.length > 0 &&
            columns.map((col) => (
              <section key={col.id} aria-label={col.label} style={{ display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0 }}>
                <header
                  className="loki-label"
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    padding: "0 4px 8px",
                    color: col.id === "done" ? "var(--loki-muted)" : "var(--loki-fg)",
                  }}
                >
                  <span>{col.label}</span>
                  <span>{col.tasks.length || ""}</span>
                </header>
                {col.tasks.length > 0 ? (
                  <div
                    role="listbox"
                    aria-label={col.label}
                    aria-multiselectable="true"
                    style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "grid", alignContent: "start", gap: 8, paddingBottom: 8 }}
                  >
                    {col.tasks.map((t) => (
                      <TaskCard
                        key={t.id}
                        {...cardProps(t)}
                        showStatus={prefs.groupBy !== "status"}
                        assignedTitle={t.metadata.assignedDesk ? (deskTitle.get(t.metadata.assignedDesk) ?? t.metadata.assignedDesk) : null}
                      />
                    ))}
                  </div>
                ) : (
                  tasks !== null && (
                    <p role="status" className="loki-meta loki-meta--wrap" style={{ margin: 0, padding: "10px 6px" }}>
                      {emptyColumn(col, query)}
                    </p>
                  )
                )}
              </section>
            ))}
        </div>
      )}

      <div
        className="loki-meta loki-meta--wrap"
        style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 24px 12px", borderTop: "1px solid var(--loki-border)", flexWrap: "wrap" }}
      >
        {sel.length > 0 || selReopen.length > 0 ? (
          <>
            <span style={{ color: "var(--loki-fg)" }}>{selected.size} selected</span>
            {sel.length > 0 && (
              <>
                <Button size="sm" tone="paper" kbd={keyFor("tasks.assign")} onClick={() => onAssign(sel, false)}>
                  assign to a chat
                </Button>
                <Button size="sm" tone="positive" kbd={keyFor("tasks.dispatch")} onClick={() => onAssign(sel, true)}>
                  dispatch now
                </Button>
                <Button size="sm" tone="paper" kbd={keyFor("tasks.done")} onClick={() => onClose(sel)}>
                  {selWaiting.length === sel.length ? "confirm done" : "done"}
                </Button>
              </>
            )}
            {selReopen.length > 0 && (
              <Button size="sm" tone="paper" kbd={keyFor("tasks.reopen")} onClick={() => onReopen(selReopen)}>
                reopen
              </Button>
            )}
            <Button size="sm" kbd={keyFor("tasks.clear")} onClick={() => setSelected(new Set())}>
              clear
            </Button>
          </>
        ) : (
          <span style={{ fontFamily: "var(--loki-mono)", fontSize: 10.5 }}>{TASK_KEYS}</span>
        )}
      </div>
    </div>
  );
}

/** In place of the list when the remembered agent has gone: the agent's name, and the agents with tasks to pick again (or all tasks). */
function MissingAgent({ agent, tasks, onPick }: { agent: string; tasks: Task[]; onPick: (view: TaskViewId) => void }) {
  const { views, agents } = useMemo(() => taskViews(tasks), [tasks]);
  const all = views[0];
  return (
    <div
      style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 24px", display: "grid", alignContent: "start", gap: 12, width: 360, maxWidth: "100%" }}
    >
      <p role="status" className="loki-meta loki-meta--wrap" style={{ margin: 0 }}>
        {missingAgentLine(agent)}
      </p>
      <ListSection title="Agents">
        {agents.map((v) => (
          <ListRow
            key={v.view}
            lead={<AgentFace name={v.label} src={null} size={20} />}
            title={v.label}
            time={String(v.count)}
            label={`${v.label}, ${v.count} task${v.count === 1 ? "" : "s"}`}
            onOpen={() => onPick(v.view)}
          />
        ))}
        <ListRow
          lead={<ListIcon name="menu" />}
          title={all.label}
          time={String(all.count)}
          label={`${all.label}, ${all.count} task${all.count === 1 ? "" : "s"}`}
          onOpen={() => onPick("all")}
        />
      </ListSection>
    </div>
  );
}

/** The key legend, read from the keymap. */
const TASK_KEYS = [
  "↑↓←→ move",
  `${keyFor("tasks.select")} select`,
  `${keyFor("tasks.assign")} assign`,
  `${keyFor("tasks.dispatch")} dispatch`,
  `${keyFor("tasks.done")} done`,
  `${keyFor("tasks.reopen")} reopen`,
  `${keyFor("tasks.blocked")} blocked`,
  `${keyFor("tasks.layout")} board/table`,
  `${keyFor("tasks.groupBy")} group`,
  `${keyFor("task.new")} new`,
  `${keyFor("tasks.filter")} filter`,
].join(" · ");

/** What an empty view says for itself. */
export function emptyView(view: TaskViewId, query: string): string {
  if (query.trim()) return "no matches";
  if (view === "mine") return `nothing of yours to do — file one with ${keyFor("task.new")}`;
  if (view === "waiting") return "nothing waiting for you — when an agent finishes one of your tasks, it waits here for you to confirm";
  if (view.startsWith("agent:")) return `nothing in Tasks for ${view.slice("agent:".length)}`;
  return `nothing yet — ask an agent to park something, or press ${keyFor("task.new")}`;
}

/** What an empty Board column says for itself. */
function emptyColumn(col: Column, query: string): string {
  if (query.trim()) return "no matches";
  switch (col.id as ColumnId) {
    case "open":
      return `nothing waiting — ask an agent to park something, or press ${keyFor("task.new")}`;
    case "in_progress":
      return "nothing in progress";
    case "blocked":
      return "nothing blocked";
    case "done":
      return "nothing done in 7 days";
    default:
      return "nothing here";
  }
}

type CardProps = {
  task: Task;
  selected: boolean;
  focused: boolean;
  tabIndex: 0 | -1;
  onClick: (e: React.MouseEvent) => void;
  onFocus: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onConfirm: () => void;
  onReopen: () => void;
  /** Filed from a chat message: open the chat at it. */
  onOpenSource?: () => void;
};

/** The Table: a header of sortable columns over one listbox of rows. */
function TaskTable({
  rows,
  sort,
  onSort,
  chatName,
  empty,
  card,
}: {
  rows: Task[];
  sort: { key: SortKey; dir: "asc" | "desc" };
  onSort: (key: SortKey) => void;
  chatName: (desk: string) => string;
  empty: string | null;
  card: (t: Task) => CardProps;
}) {
  return (
    <div style={{ minWidth: 820 }}>
      <div
        role="group"
        aria-label="Sort by"
        style={{
          display: "grid",
          gridTemplateColumns: TABLE_GRID,
          gap: 12,
          padding: "6px 12px",
          borderBottom: "1px solid var(--loki-border)",
          position: "sticky",
          top: 0,
          background: "var(--loki-bg)",
          zIndex: 1,
        }}
      >
        {TABLE_COLUMNS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={sort.key === key}
            aria-label={sort.key === key ? `${label}, sorted ${sort.dir === "asc" ? "ascending" : "descending"}` : `sort by ${label}`}
            className="loki-label"
            onClick={() => onSort(key)}
            style={{
              all: "unset",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 4,
              color: sort.key === key ? "var(--loki-fg)" : "var(--loki-muted)",
              whiteSpace: "nowrap",
            }}
          >
            {label}
            {sort.key === key && <span aria-hidden>{sort.dir === "asc" ? "↑" : "↓"}</span>}
          </button>
        ))}
      </div>
      {rows.length === 0 && empty !== null ? (
        <p role="status" className="loki-meta loki-meta--wrap" style={{ margin: 0, padding: "12px" }}>
          {empty}
        </p>
      ) : (
        <div role="listbox" aria-label="Tasks" aria-multiselectable="true" style={{ display: "grid" }}>
          {rows.map((t) => (
            <TaskRow key={t.id} {...card(t)} chatName={chatName} />
          ))}
        </div>
      )}
    </div>
  );
}

/** One Table row: the title, then a cell per column; a done? row carries Confirm and Reopen under its title. */
function TaskRow({
  task: t,
  selected,
  focused,
  tabIndex,
  onClick,
  onFocus,
  onKeyDown,
  onConfirm,
  onReopen,
  onOpenSource,
  chatName,
}: CardProps & { chatName: (desk: string) => string }) {
  const done = t.status === "closed";
  const cell = (key: SortKey) => cellText(t, key, chatName);
  return (
    <div
      role="option"
      aria-selected={selected}
      aria-label={t.title}
      tabIndex={tabIndex}
      data-task-id={t.id}
      data-focused={focused || undefined}
      onClick={onClick}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      style={{
        display: "grid",
        gridTemplateColumns: TABLE_GRID,
        gap: 12,
        alignItems: "start",
        padding: "8px 12px",
        cursor: "pointer",
        background: selected ? "var(--loki-selection)" : undefined,
        borderBottom: "1px solid var(--loki-border)",
        outline: focused ? "1px solid var(--loki-accent)" : undefined,
        outlineOffset: -1,
      }}
    >
      <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
        <TaskTitle task={t} done={done} selected={selected} />
        {isWaiting(t) && <DoneAsked task={t} onConfirm={onConfirm} onReopen={onReopen} />}
        {onOpenSource && <SourceLine task={t} onOpen={onOpenSource} />}
      </div>
      <span style={{ color: isWaiting(t) ? "var(--loki-accent)" : done ? "var(--loki-muted)" : undefined }}>{cell("status")}</span>
      <span>{t.assignee ? <AgentChip name={t.assignee} size={9.5} /> : <span className="loki-meta">—</span>}</span>
      <span>{t.metadata.by === "you" ? "you" : t.metadata.agent ? <AgentChip name={t.metadata.agent} size={9.5} /> : filedBy(t)}</span>
      <span className="loki-meta" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {cell("chat") || "—"}
      </span>
      <span className="loki-meta" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.metadata.folder}>
        {folderName(t.metadata.folder) ?? "—"}
      </span>
      <span className="loki-meta">{ago(done ? t.closedAt : t.updatedAt)}</span>
    </div>
  );
}

function TaskCard({
  task: t,
  selected,
  focused,
  tabIndex,
  assignedTitle,
  showStatus,
  onClick,
  onFocus,
  onKeyDown,
  onConfirm,
  onReopen,
  onOpenSource,
}: CardProps & { assignedTitle: string | null; showStatus: boolean }) {
  const uid = useId();
  const done = t.status === "closed";
  // A task from a message shows the message's quote, which is what its description holds.
  const showDesc = !!t.description && !done && !onOpenSource;
  const showAssigned = !!assignedTitle && !done;
  const waiting = isWaiting(t);
  // The name is the title; the rest of the card describes it.
  const describedBy = [waiting && `${uid}-done`, showDesc && `${uid}-desc`, `${uid}-meta`, showAssigned && `${uid}-to`].filter(Boolean).join(" ");
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
        background: selected ? "var(--loki-selection)" : "var(--loki-panel)",
        border: `1px solid ${focused ? "var(--loki-accent)" : selected ? "var(--loki-control-border)" : "var(--loki-border)"}`,
        borderRadius: "var(--loki-radius-lg)",
        padding: "10px 12px",
        cursor: "pointer",
        display: "grid",
        gap: 6,
      }}
    >
      <TaskTitle task={t} done={done} selected={selected} />
      {waiting && <DoneAsked id={`${uid}-done`} task={t} onConfirm={onConfirm} onReopen={onReopen} />}
      {onOpenSource && <SourceLine task={t} onOpen={onOpenSource} />}
      {showDesc && (
        <div
          id={`${uid}-desc`}
          className="loki-meta loki-meta--wrap"
          style={{ lineHeight: 1.45, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}
        >
          {t.description}
        </div>
      )}
      <TaskMeta id={`${uid}-meta`} task={t} done={done} showStatus={showStatus} />
      {showAssigned && <AssignedLine id={`${uid}-to`} task={t} title={assignedTitle!} />}
    </div>
  );
}

/** An agent's word that your task is done: who, why, and the two answers. The buttons do not select the card. */
function DoneAsked({ id, task: t, onConfirm, onReopen }: { id?: string; task: Task; onConfirm: () => void; onReopen: () => void }) {
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  return (
    <div id={id} style={{ display: "grid", gap: 6, padding: "6px 8px", borderRadius: "var(--loki-radius)", background: "var(--loki-selection)" }}>
      <span className="loki-meta loki-meta--wrap" style={{ color: "var(--loki-fg)" }}>
        <strong>done? · waiting for you</strong>
        {t.metadata.doneAskedBy ? ` · ${t.metadata.doneAskedBy}` : ""}
        {t.metadata.doneAsked && t.metadata.doneAsked !== "yes" ? `: ${t.metadata.doneAsked}` : ""}
      </span>
      <span style={{ display: "flex", gap: 6 }}>
        <Button size="sm" tone="positive" onClick={stop(onConfirm)}>
          confirm
        </Button>
        <Button size="sm" tone="paper" onClick={stop(onReopen)}>
          reopen
        </Button>
      </span>
    </div>
  );
}

/** Where a task from a message came from: the quote, and a way back to the message. It does not select the card. */
function SourceLine({ task: t, onOpen }: { task: Task; onOpen: () => void }) {
  const quote = t.metadata.quote;
  return (
    <button
      type="button"
      className="loki-task-source"
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      aria-label={`open the message this task came from${quote ? `: ${quote}` : ""}`}
    >
      <span aria-hidden>↩</span>
      <span className="loki-task-source-quote">{quote ? `“${quote}”` : "the message"}</span>
    </button>
  );
}

/** The first row: the selection box and the title, struck through once the task is done. */
function TaskTitle({ task: t, done, selected }: { task: Task; done: boolean; selected: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
      <span
        aria-hidden
        style={{
          width: 12,
          height: 12,
          marginTop: 3,
          borderRadius: 3,
          border: `1px solid ${selected ? "var(--loki-accent)" : "var(--loki-border)"}`,
          background: selected ? "var(--loki-accent)" : "transparent",
          flex: "0 0 auto",
        }}
      />
      <span
        style={{
          fontSize: 13.5,
          fontWeight: 600,
          lineHeight: 1.3,
          color: done ? "var(--loki-muted)" : "var(--loki-fg)",
          textDecoration: done ? "line-through" : undefined,
          minWidth: 0,
          overflowWrap: "anywhere",
        }}
      >
        {t.title}
      </span>
    </div>
  );
}

/** The meta line: priority (red ink when urgent), status when the columns are not statuses, id, who filed it, labels, and when it last moved. */
function TaskMeta({ id, task: t, done, showStatus }: { id: string; task: Task; done: boolean; showStatus: boolean }) {
  const urgent = t.priority <= 1 && !done;
  return (
    <div id={id} className="loki-meta loki-meta--wrap" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <span style={{ color: urgent ? "var(--loki-negative)" : undefined, fontWeight: urgent ? 600 : undefined }}>{PRIORITY_LABEL[t.priority] ?? "P2"}</span>
      <span style={{ fontFamily: "var(--loki-mono)" }}>{t.id}</span>
      {showStatus && <span>{STATUS_LABEL[columnOf(t) ?? "open"].replace(" · 7d", "")}</span>}
      {t.metadata.agent ? <AgentChip name={t.metadata.agent} size={9.5} /> : t.metadata.by === "you" ? <span>you</span> : null}
      {t.labels.map((l) => (
        <Chip key={l} static tag>
          {l}
        </Chip>
      ))}
      <span style={{ marginLeft: "auto" }}>{ago(done ? t.closedAt : t.updatedAt)}</span>
    </div>
  );
}

/** Where the task is going: the chat's title and, when known, the agent that has it. */
function AssignedLine({ id, task: t, title }: { id: string; task: Task; title: string }) {
  return (
    <div id={id} style={{ fontSize: 10.5, color: "var(--loki-accent)", display: "flex", alignItems: "center", gap: 6 }}>
      <span aria-hidden>→</span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
      {t.assignee && <AgentChip name={t.assignee} size={9.5} />}
    </div>
  );
}
