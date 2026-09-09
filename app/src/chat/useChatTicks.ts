import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * The host drives the panel with counters it bumps (⌘/ focus, ⌘F find). This hook owns those
 * imperative ticks: it puts the caret in the message box and opens the find bar with its field
 * selected. The find bar's open flag and field ref live here because the find tick is what opens it.
 */
export function useChatTicks({ focusTick, findTick, inputRef }: { focusTick: number; findTick: number; inputRef: RefObject<HTMLTextAreaElement | null> }) {
  useEffect(() => {
    if (focusTick <= 0) return;
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [focusTick, inputRef]);
  // Find in the transcript: the browser's own text search, scoped by starting from the transcript and
  // wrapping. Enter finds the next match, ⇧Enter the previous, Esc closes.
  const [findOpen, setFindOpen] = useState(false);
  const findRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (findTick <= 0) return;
    setFindOpen(true);
    const t = setTimeout(() => findRef.current?.select(), 0);
    return () => clearTimeout(t);
  }, [findTick]);
  return { findOpen, setFindOpen, findRef };
}
