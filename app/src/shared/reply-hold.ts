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

export function typedDraft(draftStore: Pick<Drafts, "keys" | "get">, draftKey: string): boolean {
  return draftStore.keys().includes(draftKey) && !!draftStore.get(draftKey).text.trim();
}

export function typedOutsideReply(outside: Pick<OutsideReplies, "get">, outsideId: string): boolean {
  return !!outside.get(outsideId).trim();
}

export function typedReplyOnCard(draftStore: Pick<Drafts, "keys" | "get">, outside: Pick<OutsideReplies, "get">, draftKey: string, outsideId: string): boolean {
  return typedDraft(draftStore, draftKey) || typedOutsideReply(outside, outsideId);
}

export function useTypedReplyOnCard(draftKey: string | null, outsideId: string | null): boolean {
  const draftTyped = useSyncExternalStore(
    useCallback((fn: () => void) => (draftKey ? drafts.subscribe(draftKey, fn) : () => {}), [draftKey]),
    () => !!draftKey && typedDraft(drafts, draftKey),
  );
  const outsideTyped = useSyncExternalStore(
    useCallback((fn: () => void) => (outsideId ? outsideReplies.subscribe(outsideId, fn) : () => {}), [outsideId]),
    () => !!outsideId && typedOutsideReply(outsideReplies, outsideId),
  );
  return draftTyped || outsideTyped;
}
