import { useEffect, useState } from "react";
import type { Reading } from "./reading";
import type { AgentsApi } from "./types";

/**
 * The reading pane's text: the memory file or the commit diff that `view` names, fetched again when
 * the agent or the view changes, a fetch that is overtaken ignored. `content` null is nothing to show
 * (binary, too large, or gone); `loadingView` while a fetch is out.
 */
export function useReading(selected: string | null, view: Reading, api: AgentsApi) {
  const [content, setContent] = useState<string | null>(null);
  const [loadingView, setLoadingView] = useState(false);
  useEffect(() => {
    if (!selected || !view) return;
    let cancelled = false;
    setLoadingView(true);
    const p = view.kind === "file" ? api.read(selected, view.path) : api.diff(selected, view.sha);
    void p.then((c) => {
      if (cancelled) return;
      setContent(c);
      setLoadingView(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, view?.kind, view?.kind === "file" ? view.path : view?.sha]);
  return { content, loadingView };
}

export type ReadingState = ReturnType<typeof useReading>;
