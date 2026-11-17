import { useSyncExternalStore } from "react";
import { Listeners } from "../../../core/listeners.ts";

export function createSessionValue<T extends string>(key: string, parse: (raw: string | null) => T, storage: () => Storage = () => sessionStorage) {
  const read = (): T => {
    try {
      return parse(storage().getItem(key));
    } catch {
      return parse(null);
    }
  };
  let value = read();
  const listeners = new Listeners();
  const set = (next: T) => {
    if (next === value) return;
    value = next;
    try {
      storage().setItem(key, next);
    } catch {}
    listeners.emit();
  };
  const subscribe = (l: () => void) => {
    return listeners.add(l);
  };
  // A value kept in localStorage follows another window's change (the Settings window, plan 2026-11-12-1505 U18).
  // sessionStorage is the window's own, so its events never come.
  if (typeof window !== "undefined")
    addEventListener("storage", (e) => {
      let area: Storage;
      try {
        area = storage();
      } catch {
        return;
      }
      if (e.key !== key || e.storageArea !== area) return;
      const next = parse(e.newValue);
      if (next === value) return;
      value = next;
      listeners.emit();
    });
  const get = () => value;
  const use = (): [T, (next: T) => void] => [useSyncExternalStore(subscribe, get, get), set];
  return { get, set, subscribe, use };
}
