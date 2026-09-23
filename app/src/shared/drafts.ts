import { useCallback, useSyncExternalStore } from "react";
import type { ImageAttachment } from "../../../core/attention/content.ts";

/**
 * A reply's draft — its text and images — keyed by agent and conversation, kept in memory for the page's
 * lifetime so leaving a conversation never costs what was typed. One store for every view of the same
 * conversation: the phone's Inbox card and desk page, the desktop's Messages and Desk tabs.
 * The factory is pure enough for Bun (test/phone-session.test.ts); the hook wires it to React.
 */

export type Draft = { text: string; images: ImageAttachment[] };
export const EMPTY_DRAFT: Draft = Object.freeze({ text: "", images: [] }) as Draft;

/** One conversation's key: the same one for its Inbox card and its desk page. */
export const draftKey = (agentId: string, conversationId: string): string => `${agentId}\u0000${conversationId}`;

export function createDrafts() {
  const store = new Map<string, Draft>();
  const subs = new Map<string, Set<() => void>>();
  const emit = (key: string) => subs.get(key)?.forEach((fn) => fn());
  return {
    /** The draft, or the one shared empty draft; the same object until it changes. */
    get: (key: string): Draft => store.get(key) ?? EMPTY_DRAFT,
    set(key: string, d: Draft) {
      if (!d.text && d.images.length === 0) {
        if (!store.delete(key)) return;
      } else store.set(key, d);
      emit(key);
    },
    /** After a send: only the submitted conversation's draft goes. */
    clear(key: string) {
      if (store.delete(key)) emit(key);
    },
    keys: (): string[] => [...store.keys()],
    subscribe(key: string, fn: () => void): () => void {
      let set = subs.get(key);
      if (!set) subs.set(key, (set = new Set()));
      set.add(fn);
      return () => {
        set.delete(fn);
        // the last reader gone: forget the key, so conversations visited once leave nothing behind
        if (set.size === 0 && subs.get(key) === set) subs.delete(key);
      };
    },
    /** How many keys have a reader (for tests). */
    watched: (): number => subs.size,
  };
}
export type Drafts = ReturnType<typeof createDrafts>;

/** The app's drafts, for the page's lifetime: tab changes, pages, disconnects and theme changes leave them alone. */
export const drafts = createDrafts();

/**
 * A conversation's draft as React state: `[draft, setDraft, clearDraft]`. A null key (nothing open) is
 * the empty draft and ignores writes. Every screen showing the same conversation sees the same text.
 */
export function useDraft(key: string | null, store: Drafts = drafts): [Draft, (d: Draft) => void, () => void] {
  const draft = useSyncExternalStore(
    useCallback((fn: () => void) => (key ? store.subscribe(key, fn) : () => {}), [key, store]),
    () => (key ? store.get(key) : EMPTY_DRAFT),
  );
  const set = useCallback((d: Draft) => key && store.set(key, d), [key, store]);
  const clear = useCallback(() => key && store.clear(key), [key, store]);
  return [draft, set, clear];
}
