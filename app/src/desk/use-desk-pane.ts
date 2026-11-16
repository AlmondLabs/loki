import { useCallback, useState } from "react";
import { EMPTY_PANE, chooseTab, escapeTab, nextFrame, openTab, tabOf, type DeskTab, type FrameRequest, type PaneState } from "./pane";

export function useDeskPane(scope: string) {
  const [state, setState] = useState<PaneState>(EMPTY_PANE);
  const [frameRequest, setFrameRequest] = useState<FrameRequest | null>(null);
  const tab = tabOf(state, scope);
  const setTab = useCallback((t: DeskTab) => setState((s) => chooseTab(s, scope, t)), [scope]);
  const open = useCallback((target: string) => setState((s) => openTab(s, target)), []);
  const escape = (typing: boolean): boolean => {
    const next = escapeTab(state, scope, { typing });
    if (!next) return false;
    setState(next);
    return true;
  };
  const frame = useCallback(
    (widgetId: string) => {
      setState((s) => chooseTab(s, scope, "desk"));
      setFrameRequest((f) => nextFrame(f, widgetId));
    },
    [scope],
  );
  return { tab, setTab, open, escape, frame, frameRequest };
}

export type DeskPaneModel = ReturnType<typeof useDeskPane>;
