import { useCallback, useEffect, useSyncExternalStore } from "react";
import { Listeners } from "../../../core/listeners.ts";
import { drafts, type Drafts } from "./drafts";
import { outsideReplies, type OutsideReplies } from "./outside-replies";

export function createReplyHold() {
  const holders = new Set<symbol>();
  const changed = new Listeners();
  return {
    raise(): () => void {
      const holder = Symbol("reply");
      holders.add(holder);
      if (holders.size === 1) changed.emit();
      return () => {
        if (holders.delete(holder) && holders.size === 0) changed.emit();
      };
    },
    held: (): boolean => holders.size > 0,
    subscribe: (fn: () => void): (() => void) => changed.add(fn),
  };
}

export type ReplyHold = ReturnType<typeof createReplyHold>;

export const replyHold = createReplyHold();

export function useReplyHold(on: boolean, store: ReplyHold = replyHold): void {
  useEffect(() => (on ? store.raise() : undefined), [on, store]);
}

export function useReplyHeld(store: ReplyHold = replyHold): boolean {
  return useSyncExternalStore(store.subscribe, store.held, store.held);
}

export function typedReplyOnCard(draftStore: Pick<Drafts, "keys" | "get">, outside: Pick<OutsideReplies, "get">, draftKey: string, outsideId: string): boolean {
  const typed = draftStore.keys().includes(draftKey) ? draftStore.get(draftKey).text : "";
  return !!typed.trim() || !!outside.get(outsideId).trim();
}

export function useTypedReplyOnCard(draftKey: string | null, outsideId: string | null): boolean {
  const subscribe = useCallback(
    (fn: () => void) => {
      const stopDraft = draftKey ? drafts.subscribe(draftKey, fn) : () => {};
      const stopOutside = outsideId ? outsideReplies.subscribe(outsideId, fn) : () => {};
      return () => {
        stopDraft();
        stopOutside();
      };
    },
    [draftKey, outsideId],
  );
  const read = () => !!draftKey && !!outsideId && typedReplyOnCard(drafts, outsideReplies, draftKey, outsideId);
  return useSyncExternalStore(subscribe, read, read);
}
