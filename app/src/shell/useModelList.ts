import { useCallback, useMemo, useRef, useState } from "react";
import { withRecent, type ModelEntry } from "../../../core/models.ts";

/**
 * The models the connected providers offer (chat_models), fetched once from loki's daemon when a picker first
 * wants it; switches go per conversation. The list belongs to one daemon: it is kept with the link's identity (open,
 * and which daemon), so a reconnect — an update restarting the daemon — reads as no list and the next ask
 * refetches. The desktop shell and the phone both hold one. Each entry carries its place among the models used
 * lately (`recent`, from the mod), which leads the picker's quick picks.
 */
const NONE: readonly string[] = [];

export function useModelList({ open, version, listModels, recent = NONE }: { open: boolean; version: string; listModels: () => Promise<ModelEntry[]>; recent?: readonly string[] }) {
  const harnessKey = `${open}:${version}`;
  const [models, setModels] = useState<{ key: string; list: ModelEntry[] } | null>(null);
  const fetched = models && models.key === harnessKey ? models.list : null;
  const list = useMemo(() => (fetched ? withRecent(fetched, recent) : null), [fetched, recent]);
  const loading = useRef<string | null>(null);
  const load = useCallback(() => {
    if (fetched || loading.current === harnessKey) return;
    loading.current = harnessKey;
    void listModels().then((m) => {
      setModels({ key: harnessKey, list: m });
      if (loading.current === harnessKey) loading.current = null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetched, harnessKey]);
  const forget = useCallback(() => setModels(null), []);
  return { list, load, forget };
}
