import { useCallback, useEffect, useState } from "react";
import {
  clampList,
  clampSidebar,
  columnsLayout,
  columnsStore,
  keptPeek,
  loadColumns,
  saveColumns,
  sidebarFits,
  toggleSidebar,
  type ColumnsPref,
} from "./columns";
import { GLASS_INSET, sidebarClearance } from "./sidebar";
import type { Segment } from "./keymap";

/**
 * The columns' state for the shell: the kept widths and fold (localStorage, columns.ts), the window's width for the
 * fold the widths decide, and a folded sidebar's peek. `layout` places the sidebar, the list (for a place with one)
 * and the detail; `setSidebar(w, commit)` moves the sidebar's edge live and keeps it when `commit` (the drag's end), and
 * `setList` the list's. A peek goes with `dismiss` (a place or a source chosen in it), a press outside the sidebar, or
 * the window widening to fit it.
 */
export function useColumn(segment: Segment, hasList: boolean) {
  const [pref, setPref] = useState<ColumnsPref>(() => loadColumns(columnsStore()));
  const [peek, setPeek] = useState(false);
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const fits = sidebarFits(pref, { windowWidth, inset: GLASS_INSET, hasList });
  // Spent once the sidebar fits: set during render (the React pattern for state derived from a prop), not in an effect.
  if (keptPeek(peek, fits) !== peek) setPeek(false);
  const dismiss = useCallback(() => setPeek(false), []);
  const toggle = useCallback(() => {
    const next = toggleSidebar(pref, fits, peek);
    setPeek(next.peek);
    if (next.pref !== pref) {
      setPref(next.pref);
      saveColumns(columnsStore(), next.pref);
    }
  }, [pref, fits, peek]);
  const setSidebar = useCallback(
    (w: number, commit: boolean) => {
      const sidebar = clampSidebar(w);
      setPref((p) => ({ ...p, sidebar }));
      // Saved outside the updater (React may run updaters twice); a drag never changes the fold, so this pref's is current.
      if (commit) saveColumns(columnsStore(), { ...pref, sidebar });
    },
    [pref],
  );
  // The list's edge, as the sidebar's: live while dragged, kept when it ends.
  const setList = useCallback(
    (w: number, commit: boolean) => {
      const list = clampList(w);
      setPref((p) => ({ ...p, list }));
      if (commit) saveColumns(columnsStore(), { ...pref, list });
    },
    [pref],
  );
  // The sidebar carries the places, so it stands beside every section, Flow included; Settings is a window of its own.
  const has = segment !== "settings";
  const frame = { windowWidth, inset: GLASS_INSET, clearance: sidebarClearance(), hasList, peek: has && peek };
  const layout = columnsLayout(has ? pref : { ...pref, collapsed: true }, frame);
  // A press anywhere but the sidebar (its glass and its toggle included) puts a peeked sidebar away, as a popover goes.
  const over = layout.sidebarOver;
  useEffect(() => {
    if (!over) return;
    const onPress = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest(".loki-column, .loki-shell-glass, .loki-sidebar-toggle")) return;
      setPeek(false);
    };
    // Captured, since the sidebar's column stops its own presses from bubbling (list-column.tsx).
    window.addEventListener("pointerdown", onPress, true);
    return () => window.removeEventListener("pointerdown", onPress, true);
  }, [over]);
  return { sidebar: pref.sidebar, layout, open: layout.sidebarShown, has, toggle, dismiss, setSidebar, setList };
}
