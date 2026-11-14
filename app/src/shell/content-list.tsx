import { useEffect, useImperativeHandle, useRef, useState, type MouseEvent, type ReactNode, type Ref } from "react";
import { Button, EmptyPane, Field, IconButton, ListRow, ListSection, type ListRowProps } from "../components";
import { Icon, type IconName } from "../shared/icons";
import { registerActions } from "./keymap";
import { createListSelection, heldRows, listKeyOf, type KeyPress, type ListSelection } from "./list-keys";

/** One item in a ContentList: a ListRow's look, the item's id, and the heading of the group it sits under, if any. */
export interface ContentRow extends Omit<ListRowProps, "onOpen" | "current" | "onMenu" | "rowId" | "tabIndex" | "onKeyDown"> {
  id: string;
  /** Rows in a run with the same section are drawn under one ListSection of that title; rows without one, bare. */
  section?: string;
}

/** What a place's owner can do to its list: act on the selected row once a pending highlight has committed (KTD3). */
export interface ContentListHandle {
  act: (act: (id: string) => void) => void;
  /**
   * ⌘[ (-1) or ⌘] (1), R16: commit the row beside the one the person sees, over the rows drawn, a selected row held
   * after it left the source included, so the step goes to its neighbour rather than the top.
   */
  step: (dir: 1 | -1) => void;
}

/** The props of `ContentList`: the source, its rows and selection, and the place's New and Search. */
export interface ContentListProps {
  /** The list's landmark name: the source's (KTD13). */
  label: string;
  /** The toolbar's title: the source's name, as Mail titles the mailbox. */
  title: string;
  /** The grey count after the title; none when null or left out. */
  count?: number | null;
  /** A grey line under the toolbar saying how the source stands (All Cards: when Learn last wrote); none when left out. */
  line?: string;
  rows: readonly ContentRow[];
  /** The committed row, as the place holds it. */
  selectedId: string | null;
  /** Commit a row: a click, Return, Tab, or an arrow's rest. */
  onSelect: (id: string) => void;
  /** Return or Tab on the committed row: move focus into the detail. */
  onEnter: (id: string) => void;
  /** A right-click or the menu key on a row, after it is committed. */
  onMenu?: (id: string, e: MouseEvent<HTMLButtonElement>) => void;
  /** The sentence an empty source shows. */
  empty: ReactNode;
  /** The place's New, in the toolbar and under the empty sentence; `keys` goes in its tooltip. */
  newAction?: { label: string; run: () => void; keys?: string };
  /**
   * False keeps New to the toolbar, off the empty sentence: where the empty source is not what New makes (an agent's
   * page with no files, while New makes an agent). Under the sentence by default.
   */
  emptyAction?: boolean;
  /** The Search text; with `onQuery`, the toolbar has a Search field and ⌥⌘F focuses it. */
  query?: string;
  onQuery?: (query: string) => void;
  ref?: Ref<ContentListHandle>;
}

/**
 * A list's own keys on a row (KTD3): ↑ ↓ Return and Tab are the list's, so they stop here, both their default and
 * their propagation. The shell's keymap is a bubbling window listener that ignores `defaultPrevented`
 * (use-shell-keys.ts), so without the stop ↓ in Learn's list would also reveal the card. With no row selected or
 * highlighted, Return and Tab have nothing to go into, so they are left alone: Tab moves focus on out of the list, and
 * Return presses the focused row, which selects it. `focusRow` is given the row the highlight moved to.
 */
export function onListKeyDown(
  e: KeyPress & Pick<Event, "preventDefault" | "stopPropagation">,
  ids: readonly string[],
  selection: ListSelection,
  focusRow: (id: string) => void,
): void {
  const key = listKeyOf(e);
  if (key === null) return;
  if ((key === "enter" || key === "tab") && selection.current() === null) return;
  e.preventDefault();
  e.stopPropagation();
  const to = selection.press(ids, key);
  if (to !== null) focusRow(to);
}

/** Runs of rows that share a section, in order. */
function groupsOf(rows: readonly ContentRow[]): Array<{ section?: string; rows: ContentRow[] }> {
  const groups: Array<{ section?: string; rows: ContentRow[] }> = [];
  for (const row of rows) {
    const last = groups.at(-1);
    if (last && last.section === row.section) last.rows.push(row);
    else groups.push({ section: row.section, rows: [row] });
  }
  return groups;
}

/**
 * The list column's one list (plan 2026-11-14-1330, KTD3), as Mail's message list: a toolbar with the source's name,
 * a grey count, the place's New and Search, then the rows on ListRow and ListSection. One roving tab stop sits on the
 * selected row; the arrows highlight and commit after a rest, a click or Return commits at once (list-keys.ts). The
 * selection is the accent while the rows have focus and grey otherwise (components.css). A selected row that leaves
 * `rows` stays drawn until the selection moves (heldRows). It always draws an empty state: the source's sentence with
 * its New, or "No Results" for a Search that matches nothing.
 */
export function ContentList({
  label,
  title,
  count = null,
  line,
  rows,
  selectedId,
  onSelect,
  onEnter,
  onMenu,
  empty,
  newAction,
  emptyAction = true,
  query = "",
  onQuery,
  ref,
}: ContentListProps) {
  // The pending highlight, with the row committed when it was made: once the place selects another row from outside
  // the list (⌘K, a notification), the highlight is stale and not drawn, and the selection drops it (list-keys.ts).
  const [highlight, setHighlight] = useState<{ id: string; over: string | null } | null>(null);
  // The selection outlives renders (its timer does); it reads the place's latest selection and callbacks through a ref.
  const latest = useRef({ selectedId, onSelect, onEnter });
  useEffect(() => {
    latest.current = { selectedId, onSelect, onEnter };
  });
  // Made on first use, from a handler or an effect, never during render, since it reads `latest`.
  const selectionRef = useRef<ListSelection | null>(null);
  const selection = () =>
    (selectionRef.current ??= createListSelection({
      committed: () => latest.current.selectedId,
      commit: (id) => latest.current.onSelect(id),
      focusDetail: (id) => latest.current.onEnter(id),
      onHighlight: (id) => setHighlight(id === null ? null : { id, over: latest.current.selectedId }),
    }));
  useEffect(() => () => selectionRef.current?.stop(), []);

  const current = highlight !== null && highlight.over === selectedId ? highlight.id : selectedId;
  const searching = query.trim() !== "";
  const shown = useHeldRows(rows, current, searching);
  const ids = shown.map((r) => r.id);
  const tabStop = current !== null && ids.includes(current) ? current : (ids.at(0) ?? null);
  useImperativeHandle(ref, () => ({ act: (act) => selection().act(act), step: (dir) => selection().step(ids, dir) }));

  const rowsRef = useRef<HTMLDivElement>(null);
  const focusRow = (id: string) => {
    for (const el of rowsRef.current?.querySelectorAll<HTMLElement>(".loki-list-row") ?? []) if (el.dataset.row === id) el.focus();
  };

  const row = (r: ContentRow) => {
    const { id, section: _section, ...look } = r;
    return (
      <ListRow
        key={id}
        {...look}
        rowId={id}
        current={id === current}
        tabIndex={id === tabStop ? 0 : -1}
        onOpen={() => selection().click(id)}
        onKeyDown={(e) => onListKeyDown(e, ids, selection(), focusRow)}
        onMenu={
          onMenu
            ? (e) => {
                selection().click(id);
                onMenu(id, e);
              }
            : undefined
        }
      />
    );
  };

  return (
    <section className="loki-content-list" aria-label={label}>
      <ListBar title={title} count={count} newAction={newAction} />
      {line && <p className="loki-content-list-line">{line}</p>}
      {onQuery && <ListSearch label={label} query={query} onQuery={onQuery} />}
      <div ref={rowsRef} className="loki-content-list-rows">
        {shown.length === 0 ? (
          <ListEmpty searching={searching} empty={empty} newAction={emptyAction ? newAction : undefined} />
        ) : (
          // A group is keyed by its first row's id: rows are unique, so the key holds as the list reorders or filters.
          groupsOf(shown).map((g) =>
            g.section === undefined ? (
              <ul key={g.rows[0].id} className="loki-list">
                {g.rows.map(row)}
              </ul>
            ) : (
              <ListSection key={g.rows[0].id} title={g.section}>
                {g.rows.map(row)}
              </ListSection>
            ),
          )
        )}
      </div>
    </section>
  );
}

/**
 * The rows drawn, a departed selected row held in place (heldRows): kept in state and moved on during render when the
 * rows, the selection or the Search change, the React pattern for state derived from props.
 */
function useHeldRows(rows: readonly ContentRow[], current: string | null, searching: boolean): readonly ContentRow[] {
  const [held, setHeld] = useState(() => ({ rows, current, searching, shown: rows }));
  if (held.rows === rows && held.current === current && held.searching === searching) return held.shown;
  const shown = heldRows(rows, held.shown, current, searching);
  setHeld({ rows, current, searching, shown });
  return shown;
}

/** The list's toolbar: the source's name, its grey count, and the place's New with its key in the tooltip. */
function ListBar({ title, count, newAction }: Pick<ContentListProps, "title" | "newAction"> & { count: number | null }) {
  return (
    <div className="loki-content-list-bar" data-tauri-drag-region="deep">
      <h2 className="loki-content-list-title">{title}</h2>
      {count !== null && <span className="loki-content-list-count">{count}</span>}
      {newAction && (
        <IconButton
          size={24}
          label={newAction.label}
          title={newAction.keys ? `${newAction.label} (${newAction.keys})` : newAction.label}
          onClick={newAction.run}
        >
          <Icon name="plus" size={16} />
        </IconButton>
      )}
    </div>
  );
}

/** The list's Search field; while it shows, ⌥⌘F (`list.search`) focuses it. */
function ListSearch({ label, query, onQuery }: { label: string; query: string; onQuery: (query: string) => void }) {
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => registerActions({ "list.search": () => searchRef.current?.focus() }), []);
  return (
    <div className="loki-content-list-search">
      <Field
        ref={searchRef}
        size="sm"
        type="search"
        name="list-search"
        autoComplete="off"
        data-1p-ignore
        data-lpignore="true"
        data-bwignore
        data-form-type="other"
        placeholder="Search"
        aria-label={`Search ${label}`}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
      />
    </div>
  );
}

/** An empty list: "No Results" for a Search that matches nothing, else the source's sentence with its New. */
function ListEmpty({ searching, empty, newAction }: { searching: boolean } & Pick<ContentListProps, "empty" | "newAction">) {
  return (
    <div className="loki-content-list-empty">
      {searching ? (
        <p className="loki-content-list-empty-title">No Results</p>
      ) : (
        <>
          <div>{empty}</div>
          {newAction && <Button onClick={newAction.run}>{newAction.label}</Button>}
        </>
      )}
    </div>
  );
}

/** The detail with nothing selected: "No Chat Selected", as Mail's "No Message Selected", centred in the pane. */
export function NothingSelected({ noun, icon }: { noun: string; icon?: IconName }) {
  return <EmptyPane icon={icon} title={`No ${noun} Selected`} style={{ position: "absolute", inset: 0 }} />;
}
