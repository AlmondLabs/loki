import { useEffect, useRef, useState, type FocusEvent, type RefObject } from "react";

export interface Fold {
  folded: boolean;
  close: () => void;
  props: {
    ref: RefObject<HTMLDivElement | null>;
    "data-reply-handle"?: true;
    onFocus?: (e: FocusEvent<HTMLDivElement>) => void;
    onBlur?: (e: FocusEvent<HTMLDivElement>) => void;
    onPointerDownCapture?: () => void;
    onClick?: () => void;
  };
}

const LAYER = '[role="dialog"], [role="menu"], [role="listbox"]';

export const outsideFold = (box: Element, target: EventTarget | null): boolean =>
  !(target instanceof Element && (box.contains(target) || !!target.closest(LAYER)));

export function useFold(on: boolean, openTick = 0): Fold {
  const ref = useRef<HTMLDivElement>(null);
  const pressing = useRef(false);
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
      if (!el || !outsideFold(el, e.target)) return;
      if (document.activeElement instanceof HTMLElement && el.contains(document.activeElement)) document.activeElement.blur();
      setOpen(false);
    };
    const released = () => {
      pressing.current = false;
    };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("pointerup", released, true);
    document.addEventListener("pointercancel", released, true);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("pointerup", released, true);
      document.removeEventListener("pointercancel", released, true);
    };
  }, [on, open]);
  const close = () => setOpen(false);
  if (!on) return { folded: false, close, props: { ref } };
  const folded = !open;
  return {
    folded,
    close,
    props: {
      ref,
      ...(folded ? { "data-reply-handle": true as const } : {}),
      onFocus: (e) => {
        if (e.target instanceof HTMLTextAreaElement) setOpen(true);
      },
      onBlur: (e) => {
        if (pressing.current || !ref.current || !outsideFold(ref.current, e.relatedTarget)) return;
        setOpen(false);
      },
      onPointerDownCapture: () => {
        pressing.current = true;
      },
      onClick: () => {
        pressing.current = false;
        if (folded) ref.current?.querySelector("textarea")?.focus();
      },
    },
  };
}
