import { useCallback, useSyncExternalStore } from "react";
import type { Attachment } from "../../../core/attention/content.ts";
import { savedDrafts } from "../../../core/attention/use-attention.ts";

export interface Draft {
  text: string;
  images: Attachment[];
}
export const EMPTY_DRAFT: Draft = Object.freeze({ text: "", images: [] });

export const draftKey = (agentId: string, conversationId: string): string => `${agentId}\u0000${conversationId}`;

export interface SavedLayer {
  text: (key: string) => string | null;
  subscribe: (fn: () => void) => () => void;
  emptied: (key: string) => void;
}

const keyParts = (key: string): [string, string] => {
  const at = key.indexOf("\u0000");
  return [key.slice(0, at), key.slice(at + 1)];
};

export const savedLayer: SavedLayer = {
  text: (key) => savedDrafts.text(...keyParts(key)),
  subscribe: (fn) => savedDrafts.subscribe(fn),
  emptied: (key) => savedDrafts.emptied(...keyParts(key)),
};

export function createDrafts(saved?: SavedLayer) {
  const store = new Map<string, Draft>();
  const subs = new Map<string, Set<() => void>>();
  const taken = new Set<string>();
  const shown = new Map<string, Draft>();
  const emit = (key: string) => subs.get(key)?.forEach((fn) => fn());
  saved?.subscribe(() => [...subs.keys()].forEach(emit));
  const savedDraft = (key: string): Draft | null => {
    const text = saved?.text(key);
    if (!text) return null;
    let d = shown.get(key);
    if (d?.text !== text) shown.set(key, (d = Object.freeze({ text, images: [] })));
    return d;
  };
  return {
    get: (key: string): Draft => store.get(key) ?? savedDraft(key) ?? EMPTY_DRAFT,
    set(key: string, d: Draft) {
      const typed = store.has(key);
      if (!d.text && d.images.length === 0) {
        if (typed) {
          store.delete(key);
          if (taken.delete(key) && saved?.text(key)) saved.emptied(key);
        } else if (saved?.text(key)) saved.emptied(key);
        else return;
      } else {
        if (!typed && saved?.text(key)) taken.add(key);
        store.set(key, d);
      }
      emit(key);
    },
    clear(key: string) {
      taken.delete(key);
      if (store.delete(key)) emit(key);
    },
    keys: (): string[] => [...store.keys()],
    subscribe(key: string, fn: () => void): () => void {
      let set = subs.get(key);
      if (!set) subs.set(key, (set = new Set()));
      set.add(fn);
      return () => {
        set.delete(fn);
        if (set.size === 0 && subs.get(key) === set) subs.delete(key);
      };
    },
    watched: (): number => subs.size,
  };
}
export type Drafts = ReturnType<typeof createDrafts>;

export const drafts = createDrafts(savedLayer);

export function useDraft(key: string | null, store: Drafts = drafts): [Draft, (d: Draft) => void, () => void] {
  const read = () => (key ? store.get(key) : EMPTY_DRAFT);
  const draft = useSyncExternalStore(
    useCallback((fn: () => void) => (key ? store.subscribe(key, fn) : () => {}), [key, store]),
    read,
    read,
  );
  const set = useCallback((d: Draft) => key && store.set(key, d), [key, store]);
  const clear = useCallback(() => key && store.clear(key), [key, store]);
  return [draft, set, clear];
}
