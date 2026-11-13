import { useEffect, useEffectEvent } from "react";

/**
 * Run `onChange` with the new value when another window changes `key` in localStorage: the Settings window and the
 * main one (plan 2026-11-12-1505, U18) each hold their own copy of a stored preference, and this keeps the other in
 * step. The browser sends the event only to the windows that did not write, so a window never hears itself.
 */
export function useStorageKey(key: string, onChange: (value: string | null) => void): void {
  const changed = useEffectEvent(onChange);
  useEffect(() => {
    const on = (e: StorageEvent) => {
      if (e.key === key && e.storageArea === localStorage) changed(e.newValue);
    };
    addEventListener("storage", on);
    return () => removeEventListener("storage", on);
  }, [key]);
}
