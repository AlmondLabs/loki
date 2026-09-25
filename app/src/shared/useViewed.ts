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

/** A conversation a look is for. */
export interface LookTarget {
  agentId: string;
  conversationId: string;
}

/** What useViewed has sent, and the look it holds back while a reply streams. */
export interface Looks {
  /** The stamp last sent (viewStamp): one viewed_mark per new last message. */
  sent: string | null;
  /** The newest look not sent yet, with the conversation it is for. */
  held: (LookTarget & { stamp: string }) | null;
}

export const NO_LOOKS: Looks = { sent: null, held: null };

/**
 * The next looks and the viewed_marks to send, given what is on screen now: `looking` (showing, the window
 * attended), `stamp` (viewStamp while looking, null when nothing is new), `running` (a turn in progress). While
 * the reply streams every chunk moves the last message, so the look is held and sent once: when the turn
 * settles, or when you leave or look away first (then the mark says you saw it up to there). Otherwise each new
 * stamp is sent once, as before.
 */
export function nextLook(prev: Looks, now: { looking: boolean; stamp: string | null; running: boolean } & Partial<LookTarget>): { looks: Looks; send: LookTarget[] } {
  const send: LookTarget[] = [];
  let { sent, held } = prev;
  const here = now.agentId && now.conversationId ? { agentId: now.agentId, conversationId: now.conversationId } : null;
  if (held && (!now.looking || !here || held.agentId !== here.agentId || held.conversationId !== here.conversationId)) {
    if (held.stamp !== sent) send.push({ agentId: held.agentId, conversationId: held.conversationId });
    sent = held.stamp;
    held = null;
  }
  if (now.looking && here) {
    if (!now.stamp) held = null; // nothing new to look at any more (the look landed, from here or the phone)
    else if (now.running) held = now.stamp === sent ? null : { ...here, stamp: now.stamp };
    else if (now.stamp !== sent) {
      send.push(here);
      sent = now.stamp;
      held = null;
    }
  }
  return { looks: sent === prev.sent && held === prev.held ? prev : { sent, held }, send };
}

/**
 * Viewed, not done: while a conversation is open on screen (`showing`, and the window attended), each new last
 * message is looked at once (viewed_mark, through `markViewed`); seen, the Inbox's "done", never moves here.
 * While its reply streams the look waits for the turn to settle (nextLook), so the chunks send none.
 * Returns the look to draw the New line from: the one from before this open, held while it stays open
 * (holdMark), so the line does not vanish the moment the open stamps its own look.
 */
export function useViewed(key: string | null, item: AttentionItem | null, showing: boolean, markViewed: (agentId: string, conversationId: string) => void): string | null {
  const [held, setHeld] = useState<HeldMark | null>(null);
  const next = holdMark(held, showing ? key : null, item);
  if (next !== held) setHeld(next);

  const attending = useAttending();
  const looking = showing && attending;
  const stamp = looking ? viewStamp(item) : null;
  const running = item?.status === "running";
  const looks = useRef<Looks>(NO_LOOKS);
  const markRef = useRef(markViewed);
  useEffect(() => {
    markRef.current = markViewed;
  });
  const agentId = item?.agentId, conversationId = item?.id;
  useEffect(() => {
    const r = nextLook(looks.current, { looking, stamp, running, agentId, conversationId });
    looks.current = r.looks;
    for (const m of r.send) markRef.current(m.agentId, m.conversationId);
  }, [looking, stamp, running, agentId, conversationId]);
  // Closed mid-stream (the pane unmounts): the held look still goes out.
  useEffect(
    () => () => {
      const r = nextLook(looks.current, { looking: false, stamp: null, running: false });
      looks.current = r.looks;
      for (const m of r.send) markRef.current(m.agentId, m.conversationId);
    },
    [],
  );
  return next?.mark ?? null;
}
