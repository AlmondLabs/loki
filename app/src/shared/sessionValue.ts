import { useSyncExternalStore } from "react";

/**
 * One value for the window, kept in sessionStorage and shared by every component that reads it — a list
 * column and the pane beside it stay on the same view without the shell holding it (plan 013 U11).
 * `parse` turns what was stored (or null) into a valid value, so a stale key reads as the default.
 */
export function createSessionValue<T extends string>(key: string, parse: (raw: string | null) => T) {
  const read = (): T => {
    try {
      return parse(sessionStorage.getItem(key));
    } catch {
      return parse(null);
    }
  };
  let value = read();
  const listeners = new Set<() => void>();
  const set = (next: T) => {
    if (next === value) return;
    value = next;
    try {
      sessionStorage.setItem(key, next);
    } catch {
      // Storage off: the value still holds for this window.
    }
    for (const l of listeners) l();
  };
  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => void listeners.delete(l);
  };
  const get = () => value;
  /** The value and its setter, re-rendering on every change. */
  const use = (): [T, (next: T) => void] => [useSyncExternalStore(subscribe, get), set];
  return { get, set, subscribe, use };
}
