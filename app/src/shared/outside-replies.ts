import { useCallback, useSyncExternalStore } from "react";

/**
 * The unsent reply on a mail or Slack card, kept in memory per card for the page's lifetime (plan 085, KTD7), the way
 * drafts.ts keeps a chat's: a lane switch that hides the card, or any other way off the screen, leaves the words in its
 * box for when it comes back. Keyed by the card's id (`idOf`), on the desktop and the phone alike. A sent reply
 * empties its box, and an empty box forgets its card. Only the text is kept; a mail's recipients start over.
 */
export function createOutsideReplies() {
  const store = new Map<string, string>();
  const subs = new Map<string, Set<() => void>>();
  const emit = (id: string) => subs.get(id)?.forEach((fn) => fn());
  return {
    /** The card's kept text, or "" when none is. */
    get: (id: string): string => store.get(id) ?? "",
    /** Keep the card's text; "" forgets it. */
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
    /** How many cards keep text (for tests). */
    size: (): number => store.size,
  };
}

/** A kept-replies store, as `createOutsideReplies` returns it. */
export type OutsideReplies = ReturnType<typeof createOutsideReplies>;

/** The app's kept replies, for the page's lifetime. */
export const outsideReplies = createOutsideReplies();

/**
 * One card's kept reply as React state, `[text, setText]`; a null id (no card) reads "" and ignores writes. Every
 * box showing the same card sees the same text.
 */
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
