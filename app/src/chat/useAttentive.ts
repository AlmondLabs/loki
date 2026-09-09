import { useEffect, useState } from "react";

/**
 * The panel is see-through unless you are using it: hovered, focused, or a reply is arriving.
 * "Recent" holds for a couple of seconds after the thread or status changes so a fresh message
 * is readable before the panel fades; `waiting` keeps it solid while a card wants an answer.
 */
export function useAttentive({ messageCount, status, waiting }: { messageCount: number; status: string; waiting: boolean }) {
  const [hover, setHover] = useState(false);
  const [focused, setFocused] = useState(false);
  const [recent, setRecent] = useState(false);
  useEffect(() => {
    setRecent(true);
    const t = setTimeout(() => setRecent(false), 2500);
    return () => clearTimeout(t);
  }, [messageCount, status]);
  const attentive = hover || focused || recent || status !== "idle" || waiting;
  return { attentive, setHover, setFocused };
}
