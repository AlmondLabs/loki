import { useEffect, useImperativeHandle, useRef, useState, type MouseEvent, type ReactNode, type Ref } from "react";
import { Button, EmptyPane, Field, IconButton, LeadRoom, ListRow, ListSection, type ListRowProps } from "../components";
import { Icon, type IconName } from "../shared/icons";
import { registerActions } from "./keymap";
import { createListSelection, heldRows, listKeyOf, type KeyPress, type ListSelection } from "./list-keys";

export interface ContentRow extends Omit<ListRowProps, "onOpen" | "current" | "onMenu" | "rowId" | "tabIndex" | "onKeyDown"> {
  id: string;
  section?: string;
}

export interface ContentListHandle {
  act: (act: (id: string) => void) => void;
  step: (dir: 1 | -1) => void;
}

export interface ContentListProps {
  label: string;
  title: string;
  count?: number | null;
  line?: string;
  rows: readonly ContentRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onPrefetch?: (id: string) => void;
  onEnter: (id: string) => void;
  onMenu?: (id: string, e: MouseEvent<HTMLButtonElement>) => void;
  empty: ReactNode;
  newAction?: { label: string; run: () => void; keys?: string };
  scope?: ReactNode;
  emptyAction?: boolean;
  query?: string;
  onQuery?: (query: string) => void;
  divided?: boolean;
  ref?: Ref<ContentListHandle>;
}

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

function groupsOf(rows: readonly ContentRow[]): Array<{ section?: string; rows: ContentRow[] }> {
  const groups: Array<{ section?: string; rows: ContentRow[] }> = [];
  for (const row of rows) {
    const last = groups.at(-1);
    if (last && last.section === row.section) last.rows.push(row);
    else groups.push({ section: row.section, rows: [row] });
  }
  return groups;
}

export function ContentList({
  label,
  title,
  count = null,
  line,
  rows,
  selectedId,
  onSelect,
  onPrefetch,
  onEnter,
  onMenu,
  empty,
  newAction,
  scope,
  emptyAction = true,
  query = "",
  onQuery,
  divided = false,
  ref,
}: ContentListProps) {
  const [highlight, setHighlight] = useState<{ id: string; over: string | null } | null>(null);
  const latest = useRef({ selectedId, onSelect, onEnter });
  useEffect(() => {
    latest.current = { selectedId, onSelect, onEnter };
  });
  const selectionRef = useRef<ListSelection | null>(null);
  const selection = () => {
    const cur = selectionRef.current;
    if (cur) return cur;
    const next = createListSelection({
      committed: () => latest.current.selectedId,
      commit: (id) => latest.current.onSelect(id),
      focusDetail: (id, via) => (via === "tab" ? tabIntoDetail(() => latest.current.onEnter(id)) : latest.current.onEnter(id)),
      onHighlight: (id) => setHighlight(id === null ? null : { id, over: latest.current.selectedId }),
    });
    selectionRef.current = next;
    return next;
  };
  useEffect(() => () => selectionRef.current?.stop(), []);

  const current = highlight?.over === selectedId ? highlight.id : selectedId;
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
        onPrefetch={onPrefetch ? () => onPrefetch(id) : undefined}
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
      <ListBar title={title} count={count} line={line} newAction={newAction} />
      {scope && <div className="loki-content-list-scope">{scope}</div>}
      {onQuery && <ListSearch label={label} query={query} onQuery={onQuery} />}
      <div ref={rowsRef} className="loki-content-list-rows" data-divided={divided || undefined}>
        {shown.length === 0 ? (
          <ListEmpty searching={searching} empty={empty} newAction={emptyAction ? newAction : undefined} />
        ) : (
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

const TABBABLE = 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

export function firstControl(root: ParentNode | null): HTMLElement | null {
  for (const el of root?.querySelectorAll<HTMLElement>(TABBABLE) ?? []) {
    if (el.tabIndex < 0 || el.matches(":disabled") || el.closest('[aria-hidden="true"], [inert], [hidden]')) continue;
    return el;
  }
  return null;
}

export function listStop(root: ParentNode | null): HTMLElement | null {
  return root?.querySelector<HTMLElement>('.loki-list-row[tabindex="0"]') ?? null;
}

const DETAIL_TOOLBARS = ".loki-pane-header, .loki-card-toolbar";

export function toolbarControl(main: ParentNode | null): HTMLElement | null {
  for (const bar of main?.querySelectorAll(DETAIL_TOOLBARS) ?? []) {
    const to = firstControl(bar);
    if (to) return to;
  }
  return null;
}

export function leaveList(list: Pick<Node, "contains"> | null, main: ParentNode | null, active: HTMLElement | null): void {
  if (!list || !active || !list.contains(active)) return;
  const to = toolbarControl(main) ?? firstControl(main);
  if (to) to.focus();
  else active.blur();
}

function tabIntoDetail(fallback: () => void): void {
  requestAnimationFrame(() => {
    const to = toolbarControl(document.querySelector("main"));
    if (to) to.focus();
    else fallback();
  });
}

function useHeldRows(rows: readonly ContentRow[], current: string | null, searching: boolean): readonly ContentRow[] {
  const [held, setHeld] = useState(() => ({ rows, current, searching, shown: rows }));
  if (held.rows === rows && held.current === current && held.searching === searching) return held.shown;
  const shown = heldRows(rows, held.shown, current, searching);
  setHeld({ rows, current, searching, shown });
  return shown;
}

function ListBar({ title, count, line, newAction }: Pick<ContentListProps, "title" | "line" | "newAction"> & { count: number | null }) {
  return (
    <div className="loki-content-list-bar" data-drag-region="">
      <LeadRoom />
      <div className="loki-content-list-head">
        <div className="loki-content-list-name">
          <h2 className="loki-content-list-title">{title}</h2>
          {count !== null && <span className="loki-content-list-count">{count}</span>}
        </div>
        {line && <p className="loki-content-list-line">{line}</p>}
      </div>
      <div className="loki-content-list-tools">
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
    </div>
  );
}

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

export function NothingSelected({ noun, icon }: { noun: string; icon?: IconName }) {
  return <EmptyPane icon={icon} title={`No ${noun} Selected`} style={{ position: "absolute", inset: 0 }} />;
}
