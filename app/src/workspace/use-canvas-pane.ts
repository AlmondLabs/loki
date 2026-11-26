import { useCallback, useState } from "react";
import { EMPTY_PANE, chooseTab, escapeTab, nextFrame, openTab, shownTab, tabOf, type CanvasTab, type FrameRequest, type PaneState } from "./pane";

export function useCanvasPane(scope: string, hasAdvisor: boolean) {
  const [state, setState] = useState<PaneState>(EMPTY_PANE);
  const [frameRequest, setFrameRequest] = useState<FrameRequest | null>(null);
  const tab = shownTab(tabOf(state, scope), hasAdvisor);
  const setTab = useCallback((t: CanvasTab) => setState((s) => chooseTab(s, scope, t)), [scope]);
  const open = useCallback((target: string) => setState((s) => openTab(s, target)), []);
  const showAdvisor = useCallback((target: string) => setState((s) => chooseTab(s, target, "advisor")), []);
  const escape = (typing: boolean): boolean => {
    const next = escapeTab(state, scope, tab, { typing });
    if (!next) return false;
    setState(next);
    return true;
  };
  const frame = useCallback(
    (widgetId: string) => {
      setState((s) => chooseTab(s, scope, "canvas"));
      setFrameRequest((f) => nextFrame(f, widgetId));
    },
    [scope],
  );
  return { tab, setTab, open, showAdvisor, escape, frame, frameRequest };
}

export type DeskPaneModel = ReturnType<typeof useCanvasPane>;
