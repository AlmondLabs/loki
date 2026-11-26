import { useCallback, useEffect, useState } from "react";
import { inDesktop, platform, type Platform } from "../workspace/env";
import { invoke } from "./desktop";
import { messageOf } from "../../../core/errors.ts";
import { useStorageKey } from "../shared/use-storage-key";

const KEY = "loki.globalShortcut";

export interface GlobalShortcut {
  available: boolean;
  enabled: boolean;
  error: string | null;
  set: (enabled: boolean) => void;
}

export function shortcutAvailable(inShell: boolean, os: Platform = platform): boolean {
  return inShell && os === "macos";
}

const AVAILABLE = shortcutAvailable(inDesktop);

/**
 * ⌥Space brings the inbox up from anywhere on the Mac, but Raycast, Alfred and the input-source switcher
 * want the same key, and macOS types a non-breaking space on it. So it is a preference: on by default,
 * remembered per Mac, applied through the shell on launch and whenever it changes.
 */
export function useGlobalShortcut(): GlobalShortcut {
  const [enabled, setEnabled] = useState(() => localStorage.getItem(KEY) !== "off");
  const [error, setError] = useState<string | null>(null);
  useStorageKey(KEY, (v) => setEnabled(v !== "off"));
  useEffect(() => {
    if (!AVAILABLE) return;
    let cancelled = false;
    void invoke("set_global_shortcut", { enabled }).then(
      () => {
        if (!cancelled) setError(null);
      },
      (e: unknown) => {
        if (!cancelled) setError(messageOf(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  const set = useCallback((on: boolean) => {
    localStorage.setItem(KEY, on ? "on" : "off");
    setEnabled(on);
  }, []);
  return { available: AVAILABLE, enabled, error, set };
}
