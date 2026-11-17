import { useEffect, useLayoutEffect, useRef } from "react";
import { keepReading, putBackAfterReveal, type Reading } from "../chat/use-transcript-scroll";
import { awayFromEnd } from "./thread-follow";

export interface Before {
  top: number;
  height: number;
}

export function holdPlace(el: HTMLElement, reading: Reading | null): Reading | null {
  return awayFromEnd(el) ? keepReading(el, reading) : null;
}

export function placeAfterReveal(el: HTMLElement, before: Before | null, reading: Reading | null): Reading | null {
  if (!awayFromEnd(el)) return null;
  if (!before) return keepReading(el, null);
  if (reading?.row.isConnected) return keepReading(el, reading);
  return putBackAfterReveal(el, before);
}

/**
 * Keeps your place in the desktop thread while you read above the bottom. The app's WebKit window has no scroll
 * anchoring of its own, and MessageScroller holds a place only when its first row moves down, which a day marker or a
 * turn drawn again never does: so the rows a reveal mounts above, and a picture loading or a step opening above, would
 * push what you read out of view. `start` is the window's first row; `beforeReveal` is called just before it moves up.
 * The rows it keeps in place are the entries' own `data-row` elements (a message, a stretch of work, an event, a widget).
 */
export function useKeepPlace(start: number) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const reading = useRef<Reading | null>(null);
  const before = useRef<Before | null>(null);
  const onScroll = (el: HTMLElement) => {
    reading.current = holdPlace(el, reading.current);
  };
  const beforeReveal = (el: HTMLElement) => {
    before.current ??= { top: el.scrollTop, height: el.scrollHeight };
  };
  useLayoutEffect(() => {
    const el = viewportRef.current;
    const was = before.current;
    before.current = null;
    if (el) reading.current = placeAfterReveal(el, was, reading.current);
  }, [start]);
  useEffect(() => {
    const el = viewportRef.current;
    const box = contentRef.current;
    if (!el || !box) return;
    const ro = new ResizeObserver(() => {
      if (el.clientHeight > 0) reading.current = holdPlace(el, reading.current);
    });
    ro.observe(box);
    return () => ro.disconnect();
  }, []);
  return { viewportRef, contentRef, onScroll, beforeReveal };
}
