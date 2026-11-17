import { useEffect, useRef, useState } from "react";
import { viewStamp, type AttentionItem } from "../../../core/attention/model.ts";
import { holdMark, type HeldMark } from "./thread";

const read = () => typeof document === "undefined" || (document.visibilityState === "visible" && document.hasFocus());

function useAttending(): boolean {
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

export interface LookTarget {
  agentId: string;
  conversationId: string;
}

export interface Looks {
  sent: string | null;
  held: (LookTarget & { stamp: string }) | null;
}

export const NO_LOOKS: Looks = { sent: null, held: null };

export function nextLook(
  prev: Looks,
  now: { looking: boolean; stamp: string | null; running: boolean } & Partial<LookTarget>,
): { looks: Looks; send: LookTarget[] } {
  const send: LookTarget[] = [];
  let { sent, held } = prev;
  const here = now.agentId && now.conversationId ? { agentId: now.agentId, conversationId: now.conversationId } : null;
  if (held && (!now.looking || held.agentId !== here?.agentId || held.conversationId !== here.conversationId)) {
    if (held.stamp !== sent) send.push({ agentId: held.agentId, conversationId: held.conversationId });
    sent = held.stamp;
    held = null;
  }
  if (now.looking && here) {
    if (!now.stamp) held = null;
    else if (now.running) held = now.stamp === sent ? null : { ...here, stamp: now.stamp };
    else if (now.stamp !== sent) {
      send.push(here);
      sent = now.stamp;
      held = null;
    }
  }
  return { looks: sent === prev.sent && held === prev.held ? prev : { sent, held }, send };
}

export function useViewed(
  key: string | null,
  item: AttentionItem | null,
  showing: boolean,
  markViewed: (agentId: string, conversationId: string) => void,
): string | null {
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
  const agentId = item?.agent_id,
    conversationId = item?.id;
  useEffect(() => {
    const r = nextLook(looks.current, { looking, stamp, running, agentId, conversationId });
    looks.current = r.looks;
    for (const m of r.send) markRef.current(m.agentId, m.conversationId);
  }, [looking, stamp, running, agentId, conversationId]);
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
