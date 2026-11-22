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
  toggleList,
  toggleSidebar,
  type ColumnsPref,
} from "./columns";
import { GLASS_INSET, sidebarClearance } from "./sidebar";
import type { Segment } from "./keymap";

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
      // Outside (React): an updater may run twice, so the width is saved outside it.
      if (commit) saveColumns(columnsStore(), { ...pref, sidebar });
    },
    [pref],
  );
  const hideList = useCallback(() => {
    const next = toggleList(pref);
    setPref(next);
    saveColumns(columnsStore(), next);
  }, [pref]);
  const setList = useCallback(
    (w: number, commit: boolean) => {
      const list = clampList(w);
      setPref((p) => ({ ...p, list }));
      if (commit) saveColumns(columnsStore(), { ...pref, list });
    },
    [pref],
  );
  const has = segment !== "settings";
  const frame = { windowWidth, inset: GLASS_INSET, clearance: sidebarClearance(), hasList, peek: has && peek };
  const layout = columnsLayout(has ? pref : { ...pref, collapsed: true }, frame);
  const over = layout.sidebarOver;
  useEffect(() => {
    if (!over) return;
    const onPress = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest(".loki-column, .loki-shell-glass, .loki-sidebar-toggle")) return;
      setPeek(false);
    };
    window.addEventListener("pointerdown", onPress, true);
    return () => window.removeEventListener("pointerdown", onPress, true);
  }, [over]);
  return { sidebar: pref.sidebar, layout, open: layout.sidebarShown, has, toggle, toggleList: hideList, dismiss, setSidebar, setList };
}
