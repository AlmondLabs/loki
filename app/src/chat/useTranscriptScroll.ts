import { useEffect, useRef, useState, type RefObject } from "react";
import type { TranscriptRow } from "./Transcript";

/**
 * Follow the bottom only while the reader is there. Scrolling up to read
 * older messages must survive streaming deltas; sending a message re-pins.
 * `unpinned` drives the "↓ latest" chip; `unpin` is for find, which moves the
 * selection into view and must not be yanked back by the next delta.
 */
export function useTranscriptScroll(scrollRef: RefObject<HTMLDivElement | null>, messages: TranscriptRow[], status: string) {
  const pinnedRef = useRef(true);
  const [unpinned, setUnpinned] = useState(false);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    pinnedRef.current = pinned;
    setUnpinned(!pinned);
  };
  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = true;
    setUnpinned(false);
    el.scrollTo({ top: el.scrollHeight });
  };
  const unpin = () => {
    pinnedRef.current = false;
    setUnpinned(true);
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const last = messages[messages.length - 1];
    if (pinnedRef.current || last?.role === "user") {
      pinnedRef.current = true;
      setUnpinned(false);
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, status, scrollRef]);
  return { unpinned, onScroll, jumpToLatest, unpin };
}
