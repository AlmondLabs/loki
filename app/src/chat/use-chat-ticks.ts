import { useEffect, useRef, useState, type RefObject } from "react";

export function useChatTicks({ focusTick, findTick, inputRef }: { focusTick: number; findTick: number; inputRef: RefObject<HTMLTextAreaElement | null> }) {
  useEffect(() => {
    if (focusTick <= 0) return;
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [focusTick, inputRef]);
  const [findOpen, setFindOpen] = useState(false);
  const findRef = useRef<HTMLInputElement>(null);
  const [seenFindTick, setSeenFindTick] = useState(0);
  if (findTick !== seenFindTick) {
    setSeenFindTick(findTick);
    if (findTick > 0) setFindOpen(true);
  }
  useEffect(() => {
    if (findTick <= 0) return;
    const t = setTimeout(() => findRef.current?.select(), 0);
    return () => clearTimeout(t);
  }, [findTick]);
  return { findOpen, setFindOpen, findRef };
}
