import { useCallback, useEffect, useState } from "react";
import { inTauri } from "../desk/env";

/** The harness's scratch folder as the shell holds it (Settings › letta). */
export interface ScratchSettings {
  path: string;
  defaultPath: string;
  isDefault: boolean;
  /** The line for a `letta` run from a terminal — a different folder from loki's on purpose. */
  terminalSuggestion: string;
}

export interface Scratch {
  /** False in a browser tab: only the shell launches a harness. */
  available: boolean;
  /** Null until the shell answered. */
  settings: ScratchSettings | null;
  busy: boolean;
  error: string | null;
  /** A new folder (under ~/.letta), or null for the default. Saves, then restarts the harness so it applies. */
  set: (path: string | null) => Promise<void>;
}

/**
 * Where Letta Code's Bash tool keeps background output. Letta's own default is a temp folder that the memory
 * subagent sandbox refuses since 0.31.13, which silently broke every dreaming pass; the shell points the
 * harness at a folder under ~/.letta instead and this hook lets Settings see and change it.
 */
export function useScratch(): Scratch {
  const [settings, setSettings] = useState<ScratchSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!inTauri) return;
    let cancelled = false;
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const s = await invoke<ScratchSettings>("scratch_settings");
        if (!cancelled) setSettings(s);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const set = useCallback(async (path: string | null) => {
    if (!inTauri) return;
    setBusy(true);
    setError(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      setSettings(await invoke<ScratchSettings>("set_scratch_dir", { path }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);
  return { available: inTauri, settings, busy, error, set };
}
