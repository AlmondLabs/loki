import { useEffect, useEffectEvent } from "react";

// Outside (HTML): the storage event reaches only the windows that did not write, so a window never hears its own change.
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
