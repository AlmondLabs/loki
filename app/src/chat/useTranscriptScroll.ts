import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import type { TranscriptRow } from "./Transcript";
import { REVEAL_PX, anchorTop, findStart, keepStart, openStart, revealStart, threadId } from "./transcriptWindow";

/**
 * Follow the bottom only while the reader is there. Scrolling up to read
 * older messages must survive streaming deltas; sending a message re-pins.
 * `unpinned` drives the "↓ latest" chip; `unpin` is for find, which moves the
 * selection into view and must not be yanked back by the next delta.
 *
 * It also keeps the window (transcriptWindow.ts): `start` is the first row mounted. Near the top of what is
 * mounted, the next chunk is revealed and the offset moved by what it added, so the row being read stays put.
 * `reveal` mounts whatever find needs before the browser searches; "↓ latest" folds the window back.
 * Layout is read in scroll handlers and animation frames, not after every update.
 */
export function useTranscriptScroll(scrollRef: RefObject<HTMLDivElement | null>, messages: TranscriptRow[], status: string, dividerAt: number | null = null, marks?: ReadonlyArray<{ before: number; who: string; change: string; title: string }>) {
  const pinnedRef = useRef(true);
  const [unpinned, setUnpinned] = useState(false);
  // The window, per thread: a new first row is a new thread and opens on its newest rows again.
  const id = threadId(messages);
  const [win, setWin] = useState(() => ({ id, start: openStart(messages.length, dividerAt) }));
  const start = win.id === id ? keepStart(win.start, messages.length, dividerAt) : openStart(messages.length, dividerAt);
  // Stored as it is drawn (React's "adjust state while rendering"), so reveals count from here and a New line
  // that goes away does not fold the window under the reader.
  if (win.id !== id || win.start !== start) setWin({ id, start });
  // Where the reader was when a reveal was asked for: put back once the rows above are in.
  const anchor = useRef<{ top: number; height: number } | null>(null);
  const frame = useRef(0);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    pinnedRef.current = pinned;
    setUnpinned(!pinned);
    if (start > 0 && nearTop(el)) revealAbove(el, anchor, setWin);
  };
  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = true;
    setUnpinned(false);
    el.scrollTo({ top: el.scrollHeight });
    // Back at the bottom: the window folds to the newest rows again (the layout effect keeps the bottom in view).
    const fold = openStart(messages.length, dividerAt);
    setWin((w) => (w.start === fold ? w : { id: w.id, start: fold }));
  };
  const unpin = () => {
    pinnedRef.current = false;
    setUnpinned(true);
  };
  /** Mount the oldest row holding `query` before the browser's find runs over the page (it only sees what is mounted). */
  const reveal = (query: string) => {
    const at = findStart(messages, start, query, marks);
    if (at < start) flushSync(() => setWin((w) => (w.start <= at ? w : { id: w.id, start: at })));
  };

  // The window moved: rows went in above, so move the offset by their height (pinned, the bottom stays in
  // view instead). Still near the top (short rows, a fling, a thread shorter than the screen): the next chunk.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const was = anchor.current;
    anchor.current = null;
    if (!el) return;
    if (pinnedRef.current) el.scrollTop = el.scrollHeight;
    else if (was) {
      // Chrome's own scroll anchoring may have moved it already; writing the offset again would stop a fling.
      const top = anchorTop(was.top, was.height, el.scrollHeight);
      if (Math.abs(el.scrollTop - top) > 1) el.scrollTop = top;
    }
    if (start > 0 && nearTop(el)) revealAbove(el, anchor, setWin);
  }, [start, scrollRef]);

  // The phone keeps its deck mounted under the other tabs (display: none), where scrollHeight is 0:
  // when the thread first gains height, land at the bottom if that is where the reader was.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let height = el.clientHeight;
    const ro = new ResizeObserver(() => {
      if (height === 0 && el.clientHeight > 0 && pinnedRef.current) el.scrollTop = el.scrollHeight;
      height = el.clientHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollRef]);
  // Follow the bottom: one scroll per frame however many updates landed in it, read and written in the frame
  // (reading scrollHeight straight after each commit forced a layout per streamed update).
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (!pinnedRef.current && last?.role !== "user") return;
    pinnedRef.current = true;
    setUnpinned(false);
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const el = scrollRef.current;
      if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
    });
  }, [messages, status, scrollRef]);
  useEffect(
    () => () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    },
    [],
  );
  return { unpinned, onScroll, jumpToLatest, unpin, start, reveal };
}

type Win = { id: string; start: number };

/** Near the top of what is mounted, on screen (a hidden thread has no height and reveals nothing). */
const nearTop = (el: HTMLElement) => el.clientHeight > 0 && el.scrollTop < REVEAL_PX;

/** The next chunk above, noting where the reader is (the first ask before a commit wins) so the layout effect can put them back. */
function revealAbove(el: HTMLElement, anchor: RefObject<{ top: number; height: number } | null>, setWin: (f: (w: Win) => Win) => void) {
  anchor.current ??= { top: el.scrollTop, height: el.scrollHeight };
  setWin((w) => (w.start === 0 ? w : { id: w.id, start: revealStart(w.start) }));
}
