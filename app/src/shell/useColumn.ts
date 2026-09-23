import { useCallback, useEffect, useState } from "react";
import { clampColumn, columnShown, hasColumn, loadColumn, saveColumn, toggleColumn, type ColumnPref } from "./column";
import type { Segment } from "./keymap";

/**
 * The list column's state for the shell: the kept width and collapse (localStorage, column.ts), the
 * window's width for the fold below 1100, and the narrow window's peek. `shown` is for the showing
 * segment; `setWidth(w, commit)` moves the edge live and keeps it when `commit` (the drag's end).
 */
export function useColumn(segment: Segment) {
  const [pref, setPref] = useState<ColumnPref>(() => loadColumn(localStorage));
  const [peek, setPeek] = useState(false);
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const toggle = useCallback(() => {
    const next = toggleColumn(pref, windowWidth, peek);
    setPeek(next.peek);
    if (next.pref !== pref) {
      setPref(next.pref);
      saveColumn(localStorage, next.pref);
    }
  }, [pref, windowWidth, peek]);
  const setWidth = useCallback(
    (w: number, commit: boolean) => {
      const width = clampColumn(w);
      setPref((p) => ({ ...p, width }));
      // Saved outside the updater (React may run updaters twice); a drag never changes the fold, so this pref's is current.
      if (commit) saveColumn(localStorage, { ...pref, width });
    },
    [pref],
  );
  const open = columnShown(pref, windowWidth, peek);
  return { width: pref.width, open, shown: hasColumn(segment) && open, has: hasColumn(segment), toggle, setWidth };
}
