import { useCallback, useEffect, useState } from "react";
import { inTauri } from "../desk/env";

const KEY = "loki.globalShortcut";

/** ⌥Space as the app holds it: on or off (Settings › keys), and why the OS refused it, if it did. */
export interface GlobalShortcut {
  /** False in a browser tab: only the shell can register a system-wide key. */
  available: boolean;
  enabled: boolean;
  /** The OS's refusal, in words — usually another app already holds ⌥Space. */
  error: string | null;
  set: (enabled: boolean) => void;
}

/**
 * ⌥Space brings the inbox up from anywhere on the Mac, but Raycast, Alfred and the input-source switcher
 * want the same key, and macOS types a non-breaking space on it. So it is a preference: on by default,
 * remembered per Mac, applied through the shell on launch and whenever it changes.
 */
export function useGlobalShortcut(): GlobalShortcut {
  const [enabled, setEnabled] = useState(() => localStorage.getItem(KEY) !== "off");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!inTauri) return;
    let cancelled = false;
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("set_global_shortcut", { enabled });
        if (!cancelled) setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  const set = useCallback((on: boolean) => {
    localStorage.setItem(KEY, on ? "on" : "off");
    setEnabled(on);
  }, []);
  return { available: inTauri, enabled, error, set };
}
