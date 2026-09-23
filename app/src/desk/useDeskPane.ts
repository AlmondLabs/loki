import { useCallback, useState } from "react";
import { EMPTY_PANE, chooseTab, escapeTab, nextFrame, openTab, tabOf, type DeskTab, type FrameRequest, type PaneState } from "./pane";

/**
 * The desk pane's state for the shell (the rules are desk/pane.ts): the tab per desk, the showing desk's
 * tab, and the frame request a widget row makes. `open(scope)` is every open from anywhere (Messages);
 * `frame(widgetId)` switches the showing desk to its Desk tab and asks the Surface to frame that widget.
 */
export function useDeskPane(scope: string) {
  const [state, setState] = useState<PaneState>(EMPTY_PANE);
  const [frameRequest, setFrameRequest] = useState<FrameRequest | null>(null);
  const tab = tabOf(state, scope);
  const setTab = useCallback((t: DeskTab) => setState((s) => chooseTab(s, scope, t)), [scope]);
  const open = useCallback((target: string) => setState((s) => openTab(s, target)), []);
  /** Esc from the shell: true when the pane took it (the Desk tab went back to Messages). */
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
