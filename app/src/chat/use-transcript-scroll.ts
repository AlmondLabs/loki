import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import type { TranscriptRow } from "./transcript";
import { REVEAL_PX, anchorTop, findStart, keepStart, openStart, revealStart, threadId } from "./transcript-window";

/**
 * Follow the bottom only while the reader is there. Scrolling up to read
 * older messages must survive streaming deltas; sending a message re-pins.
 * `unpinned` drives the "↓ latest" chip; `unpin` is for find, which moves the
 * selection into view and must not be yanked back by the next delta.
 *
 * It also keeps the window (transcript-window.ts): `start` is the first row mounted. Near the top of what is
 * mounted, the next chunk is revealed and the offset moved by what it added, so the row being read stays put.
 * `reveal` mounts whatever find needs before the browser searches; "↓ latest" folds the window back.
 * At the top of everything loaded, `older` (when the log holds more) asks for the next page; the rows it adds
 * arrive above the old first row, which is found again so the window and the reader stay where they were.
 * Scrolled up, the row being read also stays put when anything above it changes height (a picture loading, a step
 * opening): the app's WebKit window has no scroll anchoring of its own, so the thread keeps its own (`overflow-anchor:
 * none` on the thread, so a browser that has one does not move it twice).
 * Layout is read in scroll handlers, size changes and animation frames, not after every update.
 */
export function useTranscriptScroll(
  scrollRef: RefObject<HTMLDivElement | null>,
  messages: TranscriptRow[],
  status: string,
  dividerAt: number | null = null,
  marks?: ReadonlyArray<{ before: number; who: string; change: string; title: string }>,
  older: (() => void) | null = null,
) {
  const pinnedRef = useRef(true);
  const [unpinned, setUnpinned] = useState(false);
  // How many rows there were when the reader scrolled away: past it, the chip counts what came in since.
  const [leftAt, setLeftAt] = useState<number | null>(null);
  // The window, per thread: a new first row is a new thread and opens on its newest rows again.
  const id = threadId(messages);
  const [win, setWin] = useState<Win>(() => ({ id, start: openStart(messages.length, dividerAt), first: messages[0] ?? null, above: 0 }));
  // Older history loaded above: the old first row is further down now, by as many rows as arrived.
  const shift = win.id === id ? 0 : olderRowsAbove(messages, win.first);
  const start = win.id === id || shift > 0 ? keepStart(win.start + shift, messages.length, dividerAt) : openStart(messages.length, dividerAt);
  // Every row loaded above since the thread opened: the transcript keys rows past it, so a page above remounts nothing.
  const above = win.id === id ? win.above : shift > 0 ? win.above + shift : 0;
  // Stored as it is drawn (React's "adjust state while rendering"), so reveals count from here and a New line
  // that goes away does not fold the window under the reader.
  if (win.id !== id || win.start !== start) setWin({ id, start, first: messages[0] ?? null, above });
  // Rows loaded above are not new: the count of what came in since you scrolled away moves with them.
  if (shift > 0 && leftAt !== null) setLeftAt(leftAt + shift);
  // One ask for older history per page: the thread's length when asked; a new length means the page came.
  const askedOlder = useRef<number | null>(null);
  // Where the reader was when a reveal was asked for: put back once the rows above are in.
  const anchor = useRef<{ top: number; height: number } | null>(null);
  // The row being read, scrolled up, and how far below the thread's top it sat: kept there when heights change.
  const reading = useRef<Reading | null>(null);
  // The offset at the last scroll: the reader leaves the bottom only by scrolling up from it.
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
    // Scrolled up, put back what grew above since the last look (your own scroll is not undone), then look again.
    reading.current = pinned ? null : keepReading(el, reading.current);
    setUnpinned(!pinned);
    setLeftAt((at) => (pinned ? null : (at ?? messages.length)));
    if (start > 0 && nearTop(el)) revealAbove(el, anchor, setWin);
    else if (start === 0 && older && nearTop(el) && askedOlder.current !== messages.length) {
      askedOlder.current = messages.length;
      older();
    }
    // Away from the top, the next arrival there asks again: a page that failed (offline, a Mac out of reach) adds no
    // rows, and waiting for a new length would never ask for it again.
    else if (!nearTop(el)) askedOlder.current = null;
  };
  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = true;
    setUnpinned(false);
    setLeftAt(null);
    el.scrollTo({ top: el.scrollHeight });
    // Back at the bottom: the window folds to the newest rows again (the layout effect keeps the bottom in view).
    const fold = openStart(messages.length, dividerAt);
    setWin((w) => (w.start === fold ? w : { ...w, start: fold }));
  };
  const unpin = () => {
    pinnedRef.current = false;
    setUnpinned(true);
    setLeftAt((at) => at ?? messages.length);
  };
  /** Mount the oldest row holding `query` before the browser's find runs over the page (it only sees what is mounted). */
  const reveal = (query: string) => {
    const at = findStart(messages, start, query, marks);
    if (at < start) flushSync(() => setWin((w) => (w.start <= at ? w : { ...w, start: at })));
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
    // Any change of the thread's own height while the reader is at the bottom keeps them there: the message box
    // growing a line as you type shrinks the thread, and without this its last lines slide under the box. Its
    // content changing height does too, and scrolled up, the row being read is put back where it was.
    const ro = new ResizeObserver(() => {
      if (el.clientHeight === 0) return;
      if (pinnedRef.current) {
        if (el.clientHeight !== height || el.scrollHeight - el.scrollTop - el.clientHeight >= 1) el.scrollTop = el.scrollHeight;
      } else reading.current = keepReading(el, reading.current);
      height = el.clientHeight;
    });
    ro.observe(el);
    // The content is what grows (a picture loading, a step opening): watch each of the thread's own children.
    for (const child of el.children) ro.observe(child);
    const mo = new MutationObserver((changes) => {
      for (const change of changes) for (const node of change.addedNodes) if (node instanceof Element) ro.observe(node);
    });
    mo.observe(el, { childList: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [scrollRef]);
  // Follow the bottom: one scroll per frame however many updates landed in it, read and written in the frame
  // (reading scrollHeight straight after each commit forced a layout per streamed update).
  useEffect(() => {
    const last = messages.at(-1);
    if (!pinnedRef.current && last?.role !== "user") return;
    pinnedRef.current = true;
    setUnpinned(false); // the scroll to the bottom that follows clears the new-message count too (onScroll)
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
  // Rows that came in since the reader scrolled away (a new thread starts at none).
  const fresh = unpinned && leftAt !== null ? Math.max(0, messages.length - leftAt) : 0;
  return { unpinned, fresh, onScroll, jumpToLatest, unpin, start, above, reveal };
}

interface Win {
  id: string;
  start: number;
  first: TranscriptRow | null;
  above: number;
}

/** How many rows now sit above what was the first row (0 when it is not there: another thread, or nothing new above). */
export function olderRowsAbove(messages: readonly TranscriptRow[], first: TranscriptRow | null): number {
  if (!first) return 0;
  const at = messages.findIndex((r) => r.role === first.role && r.text === first.text && (r.at ?? null) === (first.at ?? null));
  return at > 0 ? at : 0;
}

/**
 * After a scroll: whether the thread follows the bottom, and whether to go back down to it now. It follows near the
 * bottom, or when it was following and this scroll did not go up: a scroll the thread made itself to follow its
 * content can land short of a bottom that grew again meanwhile (a picture loading), and that one goes back down. The
 * reader scrolling up is never pulled back, even a few pixels at a time near the bottom; far enough up, it stops
 * following.
 */
export function afterScroll(gap: number, wasPinned: boolean, top: number, lastTop: number): { pinned: boolean; stick: boolean } {
  const up = top < lastTop;
  const pinned = gap < 48 || (wasPinned && !up);
  return { pinned, stick: pinned && !up && gap >= 1 };
}

/**
 * The row at the top of the thread's view: how far below the view's top it started (negative: partly above), and
 * the scroll offset then, so a later look can tell the reader's own scrolling from content growing above.
 */
export interface Reading {
  row: Element;
  offset: number;
  scrollTop: number;
}

/** The first row still on screen at the thread's top; null with no rows. */
function readingAt(el: HTMLElement): Reading | null {
  const top = el.getBoundingClientRect().top;
  for (const row of el.querySelectorAll("[data-row]")) {
    const box = row.getBoundingClientRect();
    if (box.bottom > top + 1) return { row, offset: box.top - top, scrollTop: el.scrollTop };
  }
  return null;
}

/**
 * Keep the row that was being read where the reader left it: scrolling moves it by exactly the scroll, so anything
 * more is content above it that changed height, and the offset moves by that much. Then the row at the top now.
 */
export function keepReading(el: HTMLElement, was: Reading | null): Reading | null {
  if (was?.row.isConnected) {
    const expected = was.offset - (el.scrollTop - was.scrollTop);
    const moved = was.row.getBoundingClientRect().top - el.getBoundingClientRect().top - expected;
    if (Math.abs(moved) >= 1) el.scrollTop += moved;
  }
  return readingAt(el);
}

/** Near the top of what is mounted, on screen (a hidden thread has no height and reveals nothing). */
const nearTop = (el: HTMLElement) => el.clientHeight > 0 && el.scrollTop < REVEAL_PX;

/** The next chunk above, noting where the reader is (the first ask before a commit wins) so the layout effect can put them back. */
function revealAbove(el: HTMLElement, anchor: RefObject<{ top: number; height: number } | null>, setWin: (f: (w: Win) => Win) => void) {
  anchor.current ??= { top: el.scrollTop, height: el.scrollHeight };
  setWin((w) => (w.start === 0 ? w : { ...w, start: revealStart(w.start) }));
}
