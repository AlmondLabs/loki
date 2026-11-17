export const COMMIT_REST_MS = 150;

export type ListKey = "up" | "down" | "enter" | "tab";

export type KeyPress = Pick<KeyboardEvent, "key" | "altKey" | "metaKey" | "ctrlKey" | "shiftKey">;

export function listKeyOf(e: KeyPress): ListKey | null {
  if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return null;
  if (e.key === "ArrowUp") return "up";
  if (e.key === "ArrowDown") return "down";
  if (e.key === "Enter") return "enter";
  if (e.key === "Tab") return "tab";
  return null;
}

export interface ListMove {
  highlight: string | null;
  commit: "rest" | "now" | null;
  focusDetail: boolean;
}

export function moveFor(ids: readonly string[], current: string | null, key: ListKey): ListMove {
  if (key === "enter" || key === "tab") return { highlight: current, commit: current === null ? null : "now", focusDetail: current !== null };
  if (ids.length === 0) return { highlight: current, commit: null, focusDetail: false };
  const at = current === null ? -1 : ids.indexOf(current);
  const to = at < 0 ? (key === "down" ? 0 : ids.length - 1) : Math.max(0, Math.min(ids.length - 1, at + (key === "down" ? 1 : -1)));
  const highlight = ids[to];
  return { highlight, commit: highlight === current ? null : "rest", focusDetail: false };
}

export function heldRows<T extends { id: string }>(rows: readonly T[], previous: readonly T[], selectedId: string | null, searching = false): readonly T[] {
  if (searching || selectedId === null || rows.some((r) => r.id === selectedId)) return rows;
  const at = previous.findIndex((r) => r.id === selectedId);
  if (at < 0) return rows;
  return [...rows.slice(0, at), previous[at], ...rows.slice(at)];
}

export function stepRow(ids: readonly string[], current: string | null, dir: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const at = current === null ? -1 : ids.indexOf(current);
  if (at < 0) return dir > 0 ? ids[0] : ids[ids.length - 1];
  return ids[(at + dir + ids.length) % ids.length];
}

export type Schedule = (run: () => void, ms: number) => () => void;

const timeout: Schedule = (run, ms) => {
  const t = setTimeout(run, ms);
  return () => clearTimeout(t);
};

export interface ListSelectionOptions {
  committed: () => string | null;
  commit: (id: string) => void;
  focusDetail: (id: string, via: "enter" | "tab") => void;
  onHighlight: (id: string | null) => void;
  schedule?: Schedule;
}

export interface ListSelection {
  pending: () => string | null;
  current: () => string | null;
  press: (ids: readonly string[], key: ListKey) => string | null;
  click: (id: string) => void;
  step: (ids: readonly string[], dir: 1 | -1) => void;
  act: (act: (id: string) => void) => void;
  stop: () => void;
}

export function createListSelection(options: ListSelectionOptions): ListSelection {
  const schedule = options.schedule ?? timeout;
  let pending: string | null = null;
  let base: string | null = null;
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
  const dropStale = () => {
    if (pending !== null && options.committed() !== base) drop();
  };
  const flush = (): string | null => {
    dropStale();
    const id = pending;
    drop();
    if (id !== null) commit(id);
    return id ?? options.committed();
  };
  const current = (): string | null => {
    dropStale();
    return pending ?? options.committed();
  };
  return {
    pending: () => pending,
    current,
    press(ids, key) {
      dropStale();
      const move = moveFor(ids, pending ?? options.committed(), key);
      if (move.commit === "now") {
        const id = flush();
        if (move.focusDetail && id !== null) options.focusDetail(id, key === "tab" ? "tab" : "enter");
        return null;
      }
      if (move.commit !== "rest" || move.highlight === null) return null;
      cancel?.();
      if (pending === null) base = options.committed();
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
    step(ids, dir) {
      const to = stepRow(ids, current(), dir);
      if (to === null) return;
      drop();
      commit(to);
    },
    act(act) {
      const id = flush();
      if (id !== null) act(id);
    },
    stop: drop,
  };
}
