import { useCallback, useState } from "react";
import { EMPTY_PANE, chooseTab, escapeTab, nextFrame, openTab, shownTab, tabOf, type CanvasTab, type FrameRequest, type PaneState } from "./pane";

export function useCanvasPane(scope: string, hasWorkers: boolean) {
  const [state, setState] = useState<PaneState>(EMPTY_PANE);
  const [workerByScope, setWorkerByScope] = useState<Record<string, string>>({});
  const [frameRequest, setFrameRequest] = useState<FrameRequest | null>(null);
  const tab = shownTab(tabOf(state, scope), hasWorkers);
  const setTab = useCallback((t: CanvasTab) => setState((s) => chooseTab(s, scope, t)), [scope]);
  const open = useCallback((target: string) => setState((s) => openTab(s, target)), []);
  const selectWorker = useCallback((chatId: string) => setWorkerByScope((w) => (w[scope] === chatId ? w : { ...w, [scope]: chatId })), [scope]);
  const showWorkers = useCallback((target: string, workerChat?: string) => {
    setState((s) => chooseTab(s, target, "workers"));
    if (workerChat) setWorkerByScope((w) => (w[target] === workerChat ? w : { ...w, [target]: workerChat }));
  }, []);
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
  return { tab, setTab, open, showWorkers, selectedWorker: workerByScope[scope] ?? null, selectWorker, escape, frame, frameRequest };
}

export type DeskPaneModel = ReturnType<typeof useCanvasPane>;
