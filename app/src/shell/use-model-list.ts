import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { withRecent, type ModelEntry } from "../../../core/models.ts";

const NONE: readonly string[] = [];

export function useModelList({
  open,
  version,
  listModels,
  recent = NONE,
}: {
  open: boolean;
  version: string;
  listModels: () => Promise<ModelEntry[]>;
  recent?: readonly string[];
}) {
  const harnessKey = `${open}:${version}`;
  const [models, setModels] = useState<{ key: string; list: ModelEntry[] } | null>(null);
  const fetched = models?.key === harnessKey ? models.list : null;
  const list = useMemo(() => (fetched ? withRecent(fetched, recent) : null), [fetched, recent]);
  const loading = useRef<string | null>(null);
  const listRef = useRef(listModels);
  useEffect(() => {
    listRef.current = listModels;
  });
  const load = useCallback(() => {
    if (loading.current === harnessKey) return;
    loading.current = harnessKey;
    void listRef.current().then((m) => {
      setModels({ key: harnessKey, list: m });
      if (loading.current === harnessKey) loading.current = null;
    });
  }, [harnessKey]);
  const forget = useCallback(() => setModels(null), []);
  return { list, load, forget };
}
