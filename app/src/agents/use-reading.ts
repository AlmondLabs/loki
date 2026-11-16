import { useEffect, useEffectEvent, useState } from "react";
import type { Reading } from "./reading";
import type { AgentsApi } from "./types";

export function useReading(selected: string | null, view: Reading, api: AgentsApi) {
  const kind = view?.kind;
  const target = view?.kind === "file" ? view.path : view?.sha;
  const wanted = selected && view ? JSON.stringify([selected, kind, target]) : null;
  const [content, setContent] = useState<string | null>(null);
  const [loadingView, setLoadingView] = useState(wanted !== null);
  const [prevWanted, setPrevWanted] = useState(wanted);
  if (wanted !== prevWanted) {
    setPrevWanted(wanted);
    if (wanted !== null) setLoadingView(true);
  }
  const fetchReading = useEffectEvent((id: string, k: "file" | "commit", t: string) => (k === "file" ? api.read(id, t) : api.diff(id, t)));
  useEffect(() => {
    if (!selected || !kind || target === undefined) return;
    let cancelled = false;
    void fetchReading(selected, kind, target).then((c) => {
      if (cancelled) return;
      setContent(c);
      setLoadingView(false);
    });
    return () => {
      cancelled = true;
    };
  }, [selected, kind, target]);
  return { content, loadingView };
}

export type ReadingState = ReturnType<typeof useReading>;
