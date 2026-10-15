import { useEffect, useState } from "react";

/**
 * The panel is see-through unless you are using it: hovered, focused, or a reply is arriving.
 * "Recent" holds for a couple of seconds after the thread or status changes so a fresh message
 * is readable before the panel fades; `waiting` keeps it solid while a card wants an answer.
 */
export function useAttentive({ messageCount, status, waiting }: { messageCount: number; status: string; waiting: boolean }) {
  const [hover, setHover] = useState(false);
  const [focused, setFocused] = useState(false);
  // Each change of the thread or status is numbered; "recent" lasts until its timer marks that number settled.
  const [change, setChange] = useState({ messageCount, status, n: 0 });
  if (change.messageCount !== messageCount || change.status !== status) setChange({ messageCount, status, n: change.n + 1 });
  const [settled, setSettled] = useState(-1);
  useEffect(() => {
    const t = setTimeout(() => setSettled(change.n), 2500);
    return () => clearTimeout(t);
  }, [change.n]);
  const recent = settled !== change.n;
  const attentive = hover || focused || recent || status !== "idle" || waiting;
  return { attentive, setHover, setFocused };
}
