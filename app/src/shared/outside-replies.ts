import { useCallback, useSyncExternalStore } from "react";

export function createOutsideReplies() {
  const store = new Map<string, string>();
  const subs = new Map<string, Set<() => void>>();
  const emit = (id: string) => subs.get(id)?.forEach((fn) => fn());
  return {
    get: (id: string): string => store.get(id) ?? "",
    set(id: string, text: string) {
      if ((store.get(id) ?? "") === text) return;
      if (text) store.set(id, text);
      else store.delete(id);
      emit(id);
    },
    subscribe(id: string, fn: () => void): () => void {
      let set = subs.get(id);
      if (!set) subs.set(id, (set = new Set()));
      set.add(fn);
      return () => {
        set.delete(fn);
        if (set.size === 0 && subs.get(id) === set) subs.delete(id);
      };
    },
    size: (): number => store.size,
  };
}

export type OutsideReplies = ReturnType<typeof createOutsideReplies>;

export const outsideReplies = createOutsideReplies();

export function useOutsideReply(id: string | null, store: OutsideReplies = outsideReplies): [string, (text: string) => void] {
  const read = () => (id ? store.get(id) : "");
  const text = useSyncExternalStore(
    useCallback((fn: () => void) => (id ? store.subscribe(id, fn) : () => {}), [id, store]),
    read,
    read,
  );
  const set = useCallback((t: string) => id && store.set(id, t), [id, store]);
  return [text, set];
}
