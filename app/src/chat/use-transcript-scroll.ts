import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import type { TranscriptRow } from "./transcript";
import { REVEAL_PX, anchorTop, findStart, keepStart, openStart, revealStart, threadId } from "./transcript-window";

export function useTranscriptScroll(
  scrollRef: RefObject<HTMLDivElement | null>,
  messages: TranscriptRow[],
  status: string,
  dividerAt: number | null = null,
  older: (() => void) | null = null,
) {
  const pinnedRef = useRef(true);
  const [unpinned, setUnpinned] = useState(false);
  const [leftAt, setLeftAt] = useState<number | null>(null);
  const id = threadId(messages);
  const [win, setWin] = useState<Win>(() => ({ id, start: openStart(messages.length, dividerAt), first: messages[0] ?? null, above: 0 }));
  const shift = win.id === id ? 0 : olderRowsAbove(messages, win.first);
  const start = win.id === id || shift > 0 ? keepStart(win.start + shift, messages.length, dividerAt) : openStart(messages.length, dividerAt);
  const above = win.id === id ? win.above : shift > 0 ? win.above + shift : 0;
  if (win.id !== id || win.start !== start) setWin({ id, start, first: messages[0] ?? null, above });
  if (shift > 0 && leftAt !== null) setLeftAt(leftAt + shift);
  const askedOlder = useRef<number | null>(null);
  const anchor = useRef<{ top: number; height: number } | null>(null);
  const reading = useRef<Reading | null>(null);
  const lastTop = useRef(0);
  const frame = useRef(0);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    const { pinned, stick } = afterScroll(gap, pinnedRef.current, el.scrollTop, lastTop.current);
    lastTop.current = el.scrollTop;
    if (stick) el.scrollTop = el.scrollHeight;
    pinnedRef.current = pinned;
    reading.current = pinned ? null : keepReading(el, reading.current);
    setUnpinned(!pinned);
    setLeftAt((at) => (pinned ? null : (at ?? messages.length)));
    if (start > 0 && nearTop(el)) revealAbove(el, anchor, setWin);
    else if (start === 0 && older && nearTop(el) && askedOlder.current !== messages.length) {
      askedOlder.current = messages.length;
      older();
    } else if (!nearTop(el)) askedOlder.current = null;
  };
  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = true;
    setUnpinned(false);
    setLeftAt(null);
    el.scrollTo({ top: el.scrollHeight });
    const fold = openStart(messages.length, dividerAt);
    setWin((w) => (w.start === fold ? w : { ...w, start: fold }));
  };
  const unpin = () => {
    pinnedRef.current = false;
    setUnpinned(true);
    setLeftAt((at) => at ?? messages.length);
  };
  const reveal = (query: string) => {
    const at = findStart(messages, start, query);
    if (at < start) flushSync(() => setWin((w) => (w.start <= at ? w : { ...w, start: at })));
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const was = anchor.current;
    anchor.current = null;
    if (!el) return;
    if (pinnedRef.current) el.scrollTop = el.scrollHeight;
    else if (was) reading.current = putBackAfterReveal(el, was);
    if (start > 0 && nearTop(el)) revealAbove(el, anchor, setWin);
  }, [start, scrollRef]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let height = el.clientHeight;
    const ro = new ResizeObserver(() => {
      if (el.clientHeight === 0) return;
      if (pinnedRef.current) {
        if (el.clientHeight !== height || el.scrollHeight - el.scrollTop - el.clientHeight >= 1) el.scrollTop = el.scrollHeight;
      } else reading.current = keepReading(el, reading.current);
      height = el.clientHeight;
    });
    ro.observe(el);
    for (const child of el.children) ro.observe(child);
    const mo = new MutationObserver((changes) => {
      for (const change of changes) {
        for (const node of change.addedNodes) if (node instanceof Element) ro.observe(node);
        for (const node of change.removedNodes) if (node instanceof Element) ro.unobserve(node);
      }
    });
    mo.observe(el, { childList: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [scrollRef]);
  const tail = messages.at(-1) ?? null;
  const seenTail = useRef(tail);
  useEffect(() => {
    const sent = isNewSend(seenTail.current, tail);
    seenTail.current = tail;
    if (!pinnedRef.current && !sent) return;
    pinnedRef.current = true;
    setUnpinned(false);
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const el = scrollRef.current;
      if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
    });
  }, [messages, tail, status, scrollRef]);
  useEffect(
    () => () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    },
    [],
  );
  const fresh = unpinned && leftAt !== null ? Math.max(0, messages.length - leftAt) : 0;
  return { unpinned, fresh, onScroll, jumpToLatest, unpin, start, above, reveal };
}

interface Win {
  id: string;
  start: number;
  first: TranscriptRow | null;
  above: number;
}

export function isNewSend(seen: TranscriptRow | null, tail: TranscriptRow | null): boolean {
  return tail !== seen && tail?.role === "user" && seen !== null;
}

/**
 * Older rows went in above (a reveal): the offset moves by as much as the thread grew, so the row being read stays
 * put, then a fresh look, so the scroll this makes is not taken for content moving and put back a second time. Chrome's
 * own scroll anchoring may have moved it already; writing the offset again would stop a fling.
 */
export function putBackAfterReveal(el: HTMLElement, was: { top: number; height: number }): Reading | null {
  const top = anchorTop(was.top, was.height, el.scrollHeight);
  if (Math.abs(el.scrollTop - top) > 1) el.scrollTop = top;
  return keepReading(el, null);
}

export function olderRowsAbove(messages: readonly TranscriptRow[], first: TranscriptRow | null): number {
  if (!first) return 0;
  const at = messages.findIndex((r) => r.role === first.role && r.text === first.text && (r.at ?? null) === (first.at ?? null));
  return at > 0 ? at : 0;
}

export function afterScroll(gap: number, wasPinned: boolean, top: number, lastTop: number): { pinned: boolean; stick: boolean } {
  const up = top < lastTop;
  const pinned = gap < 48 || (wasPinned && !up);
  return { pinned, stick: pinned && !up && gap >= 1 };
}

export interface Reading {
  row: Element;
  offset: number;
  scrollTop: number;
}

function readingAt(el: HTMLElement): Reading | null {
  const top = el.getBoundingClientRect().top;
  const rows = el.querySelectorAll("[data-row]:not([data-row] [data-row])");
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].getBoundingClientRect().bottom > top + 1) hi = mid;
    else lo = mid + 1;
  }
  if (lo >= rows.length) return null;
  const row = rows[lo];
  return { row, offset: row.getBoundingClientRect().top - top, scrollTop: el.scrollTop };
}

export function keepReading(el: HTMLElement, was: Reading | null): Reading | null {
  const elTop = el.getBoundingClientRect().top;
  if (was?.row.isConnected) {
    const rect = was.row.getBoundingClientRect();
    const expected = was.offset - (el.scrollTop - was.scrollTop);
    const moved = rect.top - elTop - expected;
    const shift = Math.abs(moved) >= 1 ? moved : 0;
    if (shift) el.scrollTop += shift;
    const top = rect.top - shift;
    const bottom = rect.bottom - shift;
    if (top <= elTop + 1 && bottom > elTop + 1) return { row: was.row, offset: top - elTop, scrollTop: el.scrollTop };
  }
  return readingAt(el);
}

const nearTop = (el: HTMLElement) => el.clientHeight > 0 && el.scrollTop < REVEAL_PX;

function revealAbove(el: HTMLElement, anchor: RefObject<{ top: number; height: number } | null>, setWin: (f: (w: Win) => Win) => void) {
  anchor.current ??= { top: el.scrollTop, height: el.scrollHeight };
  setWin((w) => (w.start === 0 ? w : { ...w, start: revealStart(w.start) }));
}
