/**
 * One list's keyboard and selection, as Mail's message list (plan 2026-11-14-1330, KTD3). Pure, so the rules are
 * tested without a window: ↑ ↓ highlight a row at once and commit it after COMMIT_REST_MS of rest, so holding an arrow
 * does not load every item it passes; a click, Return or Tab commits at once; and anything that acts on the selection
 * (a Flow move, a context-menu item) commits a pending highlight first, so it acts on the row the person sees.
 */

/** How long the arrows rest before a highlight commits, in ms: long enough to pass rows, short enough to feel at once. */
export const COMMIT_REST_MS = 150;

/** A key the list takes for itself: the arrows move, Return and Tab go into the detail. */
export type ListKey = "up" | "down" | "enter" | "tab";

/** A keydown's key and modifiers, the part of a KeyboardEvent the list reads. */
export type KeyPress = Pick<KeyboardEvent, "key" | "altKey" | "metaKey" | "ctrlKey" | "shiftKey">;

/** The list's own key for an event, or null for one it leaves to the keymap (any modifier) or the browser (⇧Tab moves back). */
export function listKeyOf(e: KeyPress): ListKey | null {
  if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return null;
  if (e.key === "ArrowUp") return "up";
  if (e.key === "ArrowDown") return "down";
  if (e.key === "Enter") return "enter";
  if (e.key === "Tab") return "tab";
  return null;
}

/** What a key does to the selection: the row now highlighted, whether it commits after the rest or now, and whether focus goes into the detail. */
export interface ListMove {
  highlight: string | null;
  commit: "rest" | "now" | null;
  focusDetail: boolean;
}

/**
 * A key on rows `ids` with `current` highlighted (the pending row, else the committed one). The arrows stay put at
 * either end; with nothing highlighted ↓ takes the first row and ↑ the last. A row no longer among `ids` (one held
 * by `heldRows`) steps from where the rows start, as a list with nothing selected does.
 */
export function moveFor(ids: readonly string[], current: string | null, key: ListKey): ListMove {
  if (key === "enter" || key === "tab") return { highlight: current, commit: current === null ? null : "now", focusDetail: current !== null };
  if (ids.length === 0) return { highlight: current, commit: null, focusDetail: false };
  const at = current === null ? -1 : ids.indexOf(current);
  const to = at < 0 ? (key === "down" ? 0 : ids.length - 1) : Math.max(0, Math.min(ids.length - 1, at + (key === "down" ? 1 : -1)));
  const highlight = ids[to];
  return { highlight, commit: highlight === current ? null : "rest", focusDetail: false };
}

/**
 * The rows to draw: `rows`, plus the selected row where it stood in `previous` when it has left `rows`, so a row
 * answered or archived elsewhere stays in view until the selection moves (R11's rule, for every list). A Search
 * (`searching`) hides the selected row like any other, since the person asked for only the matches. Returns `rows`
 * itself when nothing is held.
 */
export function heldRows<T extends { id: string }>(rows: readonly T[], previous: readonly T[], selectedId: string | null, searching = false): readonly T[] {
  if (searching || selectedId === null || rows.some((r) => r.id === selectedId)) return rows;
  const at = previous.findIndex((r) => r.id === selectedId);
  if (at < 0) return rows;
  return [...rows.slice(0, at), previous[at], ...rows.slice(at)];
}

/** Runs `run` after `ms` and returns its cancel: setTimeout in the app, a hand-moved clock in tests. */
export type Schedule = (run: () => void, ms: number) => () => void;

const timeout: Schedule = (run, ms) => {
  const t = setTimeout(run, ms);
  return () => clearTimeout(t);
};

/** What a list's selection reads and tells its owner. */
export interface ListSelectionOptions {
  /** The committed row, as the place holds it now. */
  committed: () => string | null;
  /** Commit a row: the place loads it in the detail. Never called for the row already committed. */
  commit: (id: string) => void;
  /** Move focus into the detail of this (committed) row: Return or Tab. */
  focusDetail: (id: string) => void;
  /** The pending highlight changed, for the list to draw it; null once it commits or is dropped. */
  onHighlight: (id: string | null) => void;
  schedule?: Schedule;
}

/** A list's selection over time: the pending highlight and its rest, and the ways in which it commits. */
export interface ListSelection {
  /** The highlighted row waiting out its rest, or null. */
  pending: () => string | null;
  /** A key on rows `ids`; returns the row to focus when the highlight moved, else null. */
  press: (ids: readonly string[], key: ListKey) => string | null;
  /** A click on a row: commits it at once. */
  click: (id: string) => void;
  /** Commit the pending highlight now, then run `act` on the selected row, if there is one. */
  act: (act: (id: string) => void) => void;
  /** Drop a pending highlight and its timer, as the list goes away. */
  stop: () => void;
}

/** A selection for one list, committing through `options` (see ListSelection). */
export function createListSelection(options: ListSelectionOptions): ListSelection {
  const schedule = options.schedule ?? timeout;
  let pending: string | null = null;
  let cancel: (() => void) | null = null;
  const commit = (id: string) => {
    if (id !== options.committed()) options.commit(id);
  };
  const drop = () => {
    cancel?.();
    cancel = null;
    if (pending === null) return;
    pending = null;
    options.onHighlight(null);
  };
  /** Commit a pending highlight now; the selected row after it, pending or committed. */
  const flush = (): string | null => {
    const id = pending;
    drop();
    if (id !== null) commit(id);
    return id ?? options.committed();
  };
  return {
    pending: () => pending,
    press(ids, key) {
      const move = moveFor(ids, pending ?? options.committed(), key);
      if (move.commit === "now") {
        const id = flush();
        if (move.focusDetail && id !== null) options.focusDetail(id);
        return null;
      }
      if (move.commit !== "rest" || move.highlight === null) return null;
      cancel?.();
      pending = move.highlight;
      options.onHighlight(pending);
      cancel = schedule(() => {
        cancel = null;
        flush();
      }, COMMIT_REST_MS);
      return pending;
    },
    click(id) {
      drop();
      commit(id);
    },
    act(act) {
      const id = flush();
      if (id !== null) act(id);
    },
    stop: drop,
  };
}
