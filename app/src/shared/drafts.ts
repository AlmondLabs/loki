import { useCallback, useSyncExternalStore } from "react";
import type { Attachment } from "../../../core/attention/content.ts";
import { savedDrafts } from "../../../core/attention/use-attention.ts";

/**
 * A reply's draft — its text and images — keyed by agent and conversation, kept in memory for the page's
 * lifetime so leaving a conversation never costs what was typed. One store for every view of the same
 * conversation: the phone's Inbox card and desk page, the desktop's Messages and Desk tabs.
 * Beneath what is typed lies the chat's saved draft (plan 049, KTD7): a suggestion saved for this chat shows in its box
 * while nothing is typed there, so text already typed always wins, and the draft waits until the box is empty.
 * The factory is pure enough for a test without a DOM (test/phone-session.test.ts); the hook wires it to React.
 */

/** A reply's draft: its text and the images attached. */
export interface Draft {
  text: string;
  images: Attachment[];
}
/** The one shared empty draft: nothing typed, nothing attached. */
export const EMPTY_DRAFT: Draft = Object.freeze({ text: "", images: [] });

/** One conversation's key: the same one for its Inbox card and its desk page. */
export const draftKey = (agentId: string, conversationId: string): string => `${agentId}\u0000${conversationId}`;

/** The saved drafts beneath the typed ones, by draft key: each one's text, a change to any, and a box emptied of one. */
export interface SavedLayer {
  text: (key: string) => string | null;
  subscribe: (fn: () => void) => () => void;
  emptied: (key: string) => void;
}

/** A draft key's agent and conversation (`draftKey` the other way). */
const keyParts = (key: string): [string, string] => {
  const at = key.indexOf("\u0000");
  return [key.slice(0, at), key.slice(at + 1)];
};

/** The client's saved drafts (core/attention/use-attention.ts, kept from the Inbox list), by draft key. */
export const savedLayer: SavedLayer = {
  text: (key) => savedDrafts.text(...keyParts(key)),
  subscribe: (fn) => savedDrafts.subscribe(fn),
  emptied: (key) => savedDrafts.emptied(...keyParts(key)),
};

/**
 * A drafts store: read, write, clear and subscribe by key (`draftKey`); an empty draft written removes its key.
 * With `saved`, a key with nothing typed reads as its saved draft. Writing over a saved draft takes it into the box,
 * and emptying a box that held it, untouched or edited, tells `saved` it was emptied; emptying a box whose own
 * text sat over a saved draft brings the saved one up.
 */
export function createDrafts(saved?: SavedLayer) {
  const store = new Map<string, Draft>();
  const subs = new Map<string, Set<() => void>>();
  /** The keys whose typed draft began as their saved one. */
  const taken = new Set<string>();
  /** Each saved draft as a Draft, so a read gives the same object until its text changes. */
  const shown = new Map<string, Draft>();
  const emit = (key: string) => subs.get(key)?.forEach((fn) => fn());
  // A saved draft that came or went may change what any open box reads; the few readers each check theirs.
  saved?.subscribe(() => [...subs.keys()].forEach(emit));
  const savedDraft = (key: string): Draft | null => {
    const text = saved?.text(key);
    if (!text) return null;
    let d = shown.get(key);
    if (d?.text !== text) shown.set(key, (d = Object.freeze({ text, images: [] })));
    return d;
  };
  return {
    /** The draft, its saved draft when nothing is typed, or the one shared empty draft; the same object until it changes. */
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
    /** After a send: only the submitted conversation's draft goes. */
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
        // the last reader gone: forget the key, so conversations visited once leave nothing behind
        if (set.size === 0 && subs.get(key) === set) subs.delete(key);
      };
    },
    /** How many keys have a reader (for tests). */
    watched: (): number => subs.size,
  };
}
/** A drafts store, as `createDrafts` returns it. */
export type Drafts = ReturnType<typeof createDrafts>;

/** The app's drafts, for the page's lifetime: tab changes, pages, disconnects and theme changes leave them alone. */
export const drafts = createDrafts(savedLayer);

/**
 * A conversation's draft as React state: `[draft, setDraft, clearDraft]`. A null key (nothing open) is
 * the empty draft and ignores writes. Every screen showing the same conversation sees the same text.
 */
export function useDraft(key: string | null, store: Drafts = drafts): [Draft, (d: Draft) => void, () => void] {
  const read = () => (key ? store.get(key) : EMPTY_DRAFT);
  // the same read for a server render (the tests render cards to markup)
  const draft = useSyncExternalStore(
    useCallback((fn: () => void) => (key ? store.subscribe(key, fn) : () => {}), [key, store]),
    read,
    read,
  );
  const set = useCallback((d: Draft) => key && store.set(key, d), [key, store]);
  const clear = useCallback(() => key && store.clear(key), [key, store]);
  return [draft, set, clear];
}
