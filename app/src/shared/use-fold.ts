import { useEffect, useRef, useState, type FocusEvent, type RefObject } from "react";

export interface Fold {
  folded: boolean;
  props: {
    ref: RefObject<HTMLDivElement | null>;
    "data-reply-handle"?: true;
    onFocus?: (e: FocusEvent<HTMLDivElement>) => void;
    onClick?: () => void;
  };
}

export function useFold(on: boolean, openTick = 0): Fold {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [seenTick, setSeenTick] = useState(0);
  if (seenTick !== openTick) {
    setSeenTick(openTick);
    if (openTick > 0) setOpen(true);
  }
  useEffect(() => {
    if (!on || !open) return;
    const away = (e: PointerEvent) => {
      const el = ref.current;
      if (!el || (e.target instanceof Node && el.contains(e.target))) return;
      if (document.activeElement instanceof HTMLElement && el.contains(document.activeElement)) document.activeElement.blur();
      setOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [on, open]);
  if (!on) return { folded: false, props: { ref } };
  const folded = !open;
  return {
    folded,
    props: {
      ref,
      ...(folded ? { "data-reply-handle": true as const } : {}),
      onFocus: (e) => {
        if (e.target instanceof HTMLTextAreaElement) setOpen(true);
      },
      onClick: () => {
        if (folded) ref.current?.querySelector("textarea")?.focus();
      },
    },
  };
}
