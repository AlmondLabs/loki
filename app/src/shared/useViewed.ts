import { useEffect, useRef, useState } from "react";
import { viewStamp, type AttentionItem } from "../../../core/attention/model.ts";
import { holdMark, type HeldMark } from "./thread";

/** The window is on screen and has the focus (a widget's frame holding it counts): someone can be reading. */
function useAttending(): boolean {
  const read = () => typeof document === "undefined" || (document.visibilityState === "visible" && document.hasFocus());
  const [on, setOn] = useState(read);
  useEffect(() => {
    const up = () => setOn(read());
    window.addEventListener("focus", up);
    window.addEventListener("blur", up);
    document.addEventListener("visibilitychange", up);
    return () => {
      window.removeEventListener("focus", up);
      window.removeEventListener("blur", up);
      document.removeEventListener("visibilitychange", up);
    };
  }, []);
  return on;
}

/**
 * Viewed, not done: while a conversation is open on screen (`showing`, and the window attended), each new last
 * message is looked at once (viewed_mark, through `markViewed`); seen, the Inbox's "done", never moves here.
 * Returns the look to draw the New line from: the one from before this open, held while it stays open
 * (holdMark), so the line does not vanish the moment the open stamps its own look.
 */
export function useViewed(key: string | null, item: AttentionItem | null, showing: boolean, markViewed: (agentId: string, conversationId: string) => void): string | null {
  const [held, setHeld] = useState<HeldMark | null>(null);
  const next = holdMark(held, showing ? key : null, item);
  if (next !== held) setHeld(next);

  const attending = useAttending();
  const stamp = showing && attending ? viewStamp(item) : null;
  const sent = useRef<string | null>(null);
  const markRef = useRef(markViewed);
  useEffect(() => {
    markRef.current = markViewed;
  });
  const agentId = item?.agentId, conversationId = item?.id;
  useEffect(() => {
    if (!stamp || stamp === sent.current || !agentId || !conversationId) return;
    sent.current = stamp;
    markRef.current(agentId, conversationId);
  }, [stamp, agentId, conversationId]);
  return next?.mark ?? null;
}
