import { useCallback, useRef, useState } from "react";
import type { ModelEntry } from "../../../core/models.ts";

/**
 * list_models, fetched once from the app-server when a picker first wants it; switches go per conversation.
 * The list belongs to one harness: it is kept with the link's identity (open, and which Letta Code), so a
 * reconnect — an update restarting the harness — or a different version reads as no list and the next ask
 * refetches. The desktop shell and the phone both hold one.
 */
export function useModelList({ open, version, listModels }: { open: boolean; version: string; listModels: () => Promise<ModelEntry[]> }) {
  const harnessKey = `${open}:${version}`;
  const [models, setModels] = useState<{ key: string; list: ModelEntry[] } | null>(null);
  const list = models && models.key === harnessKey ? models.list : null;
  const loading = useRef<string | null>(null);
  const load = useCallback(() => {
    if (list || loading.current === harnessKey) return;
    loading.current = harnessKey;
    void listModels().then((m) => {
      setModels({ key: harnessKey, list: m });
      if (loading.current === harnessKey) loading.current = null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, harnessKey]);
  const forget = useCallback(() => setModels(null), []);
  return { list, load, forget };
}
