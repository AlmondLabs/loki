import { Thought } from "./thought";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
  type RefObject,
  type UIEvent,
  type WheelEvent,
} from "react";
import { flushSync } from "react-dom";
import { prefersReducedMotion } from "../kit/motion";
import { ArrowDownIcon } from "lucide-react";
import type { TranscriptRow } from "../../../core/attention/transcript.ts";
import { Button } from "@/ui/button";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
  useMessageScrollerScrollable,
} from "@/ui/message-scroller";
import { Trace, TraceLine, TraceTitle } from "@/ui/trace";
import type { ThreadHandle, ThreadProps } from "../chat/conversation";
import { ThreadError } from "../chat/thread-error";
import { ThreadAnnouncer } from "../chat/thread-announcer";
import { StepsLoad } from "../chat/tool-steps";
import { CommandRow, useArrivedFrom } from "../chat/transcript";
import { findStart, keepStart, openStart, threadId } from "../chat/transcript-window";
import { threadEntries, threadTurns, thoughtsIntoWork, type TurnPart } from "./entries";
import { WidgetArtifact } from "./content-parts";
import { ChangeEntry, DayMarker, EventEntry, NewMarker } from "./event-entry";
import { chatEntries, type ItemEntry } from "./item-view";
import { ChatMessage } from "./message-entry";
import { Work, samePlan, stretchPlan } from "./work";
import { AgentTurn } from "./agent-turn";
import { useKeepPlace } from "./use-keep-place";
import { drawnRows, keepsFollowing, lastShown, newSince, nextAbove, restTimer, revealFrom } from "./thread-follow";
import { isNewSend } from "../chat/use-transcript-scroll";

const TIME_GAP = 15 * 60_000;

const EMPTY: TranscriptRow[] = [];

export const Timeline = forwardRef<ThreadHandle, Omit<ThreadProps, "phone">>(function Timeline(props, ref) {
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <ThreadBody {...props} handle={ref} />
    </MessageScrollerProvider>
  );
});

function ThreadBody({
  rows,
  status = "idle",
  error = null,
  agentName,
  waiting = false,
  onCancelQueued,
  onRetry,
  onKeepHere,
  older = null,
  loadFailed = null,
  loadStep,
  home = null,
  blank = false,
  layout,
  tail,
  style,
  handle,
}: Omit<ThreadProps, "phone"> & { handle: Ref<ThreadHandle> }) {
  const list = rows ?? EMPTY;
  const drawn = drawnRows(list);
  const arrivedFrom = useArrivedFrom(rows);
  const dividerAt = layout?.dividerAt ?? null;
  const widgets = layout?.widgets ?? [];
  const { start, above, nearTop, reveal, fold } = useThreadWindow(list, dividerAt, widgets, older);
  const atRest = useRef(() => {});
  const rest = useRest(atRest, start, list.length);
  const { viewportRef, contentRef, onScroll: holdOnScroll, beforeReveal } = useKeepPlace(start, rest.moving);
  useEffect(() => {
    atRest.current = () => {
      if (viewportRef.current) nearTop(viewportRef.current, beforeReveal);
    };
  });
  const fresh = useFresh(drawn, above);
  useFollowSend(list);
  const { scrollToEnd } = useMessageScroller();
  const foldAtEnd = useRef(false);
  useImperativeHandle(
    handle,
    () => ({
      unpin: () => {},
      reveal,
    }),
    [reveal],
  );
  const cancelRef = useRef(onCancelQueued);
  const stepRef = useRef(loadStep);
  useEffect(() => {
    cancelRef.current = onCancelQueued;
    stepRef.current = loadStep;
  }, [onCancelQueued, loadStep]);
  const cancelQueued = useCallback((row: TranscriptRow) => cancelRef.current?.(row.text), []);
  const stableLoadStep = useCallback((row: number) => stepRef.current?.(row) ?? Promise.resolve(null), []);

  const who = layout?.people?.assistant.name ?? agentName ?? "the agent";
  const shown = rows ? drawn : undefined;
  const entries: ItemEntry[] = shown
    ? chatEntries(
        threadTurns(
          threadEntries({
            rows: shown,
            from: start,
            above,
            dividerAt,
            dividerDay: layout?.dividerDay ?? null,
            widgets,
            busy: status !== "idle",
            arrivedFrom,
            gaps: TIME_GAP,
          }),
          { busy: status !== "idle", waiting },
        ),
      )
    : [];
  const repeated = new Set<string>();
  let lastPlan: ReturnType<typeof stretchPlan> = null;
  for (const e of entries)
    for (const p of e.kind === "turn" ? e.parts : [])
      if (p.kind === "steps") {
        const plan = stretchPlan(p.rows);
        if (!plan) continue;
        if (samePlan(plan, lastPlan)) repeated.add(p.key);
        lastPlan = plan;
      }
  const thoughts = thoughtsIntoWork(entries.flatMap((e) => (e.kind === "turn" ? [e.parts] : [])));
  const tailEntry = entries.at(-1);
  const turnWorking = tailEntry?.kind === "turn" && tailEntry.state === "working";
  const message = (e: Extract<TurnPart, { kind: "message" }>) => (
    <ChatMessage
      row={e.row}
      last={e.last}
      streaming={status === "streaming" && e.last}
      arrived={e.arrived}
      onCancelQueued={e.row.queued && onCancelQueued ? cancelQueued : undefined}
    />
  );
  const paused = (stretch: TranscriptRow[]) => {
    const tail = stretch.at(-1);
    return waiting && tail?.role === "tool" && !tail.tool?.output;
  };
  const part = (p: TurnPart) => {
    switch (p.kind) {
      case "day":
        return <DayMarker label={p.label} />;
      case "new":
        return <NewMarker day={p.day} />;
      case "widget":
        return <WidgetArtifact mark={p.mark} live={p.live} inline={layout?.inline} onFrame={layout?.onFrameWidget} onShowDesk={layout?.onShowDesk} />;
      case "steps":
        return (
          <Work
            rows={p.rows}
            thoughts={thoughts.into.get(p.key)}
            running={p.running || paused(p.rows)}
            arrived={p.arrived}
            waiting={paused(p.rows)}
            planAsBefore={repeated.has(p.key)}
          />
        );
      case "event":
        return <EventEntry row={p.row} arrived={p.arrived} />;
      case "message":
        return (
          <>
            {!thoughts.folded.has(p.key) && <Thought rows={[p.row]} />}
            {message(p)}
          </>
        );
    }
  };
  const draw = (e: ItemEntry) => {
    switch (e.kind) {
      case "day":
        return <DayMarker label={e.label} />;
      case "new":
        return <NewMarker day={e.day} />;
      case "chat_message":
        return message(e.entry);
      case "message":
        return null;
      case "event":
        return <ChangeEntry who={e.who} text={e.text} at={e.at} />;
      case "command":
        return <CommandRow row={e.row} arrived={e.arrived || undefined} />;
      case "turn":
        return <AgentTurn agentName={who} state={e.state} failed={e.failed} took={e.took} parts={e.parts} draw={part} />;
    }
  };
  return (
    <MessageScroller data-new-thread className="flex-1">
      <MessageScrollerViewport
        ref={viewportRef}
        preserveScrollOnPrepend
        onScroll={(ev: UIEvent<HTMLDivElement>) => {
          const el = ev.currentTarget;
          rest.moved();
          holdOnScroll(el);
          if (foldAtEnd.current && el.scrollHeight - el.scrollTop - el.clientHeight < 1) {
            foldAtEnd.current = false;
            fold();
          }
        }}
        // Outside (shadcn): MessageScroller stops following on any wheel or scroll key; at the bottom, one that goes
        // nowhere follows again.
        onWheel={(ev: WheelEvent<HTMLDivElement>) => {
          rest.moved();
          if (keepsFollowing(ev.currentTarget, ev)) scrollToEnd();
        }}
        onKeyDown={(ev: KeyboardEvent<HTMLDivElement>) => {
          rest.moved();
          if (keepsFollowing(ev.currentTarget, ev)) scrollToEnd();
        }}
        onTouchMove={rest.moved}
        data-thread-scroll
        // Outside (Chrome): its scroll anchoring would move the row being read a second time, after the thread's own.
        className="[overflow-anchor:none]"
        style={style}
      >
        <MessageScrollerContent ref={contentRef} className="mx-auto w-full max-w-3xl gap-4 py-5 text-sm text-foreground">
          {!rows && !loadFailed && <p className="m-0 text-xs text-muted-foreground">{home ? `Loading from ${home}…` : "Loading the thread…"}</p>}
          {!rows && loadFailed && (
            <div role="alert" className="flex items-center gap-2 text-xs text-destructive">
              <span>{home ? `Could not load this chat from ${home}` : "Could not load this chat"}</span>
              <Button size="sm" variant="outline" onClick={loadFailed}>
                Try Again
              </Button>
            </div>
          )}
          {rows?.length === 0 && !blank && (
            <p className="m-0 text-xs text-muted-foreground">Nothing here yet — everything you send lands in {who}'s transcript</p>
          )}
          <StepsLoad.Provider value={stableLoadStep}>
            {entries.map((e) => (
              // Outside (shadcn): MessageScrollerItem skips drawing rows off screen, and their stand-in height would change
              // as each one scrolled into view above you, with nothing to put your place back.
              <MessageScrollerItem key={e.key} messageId={e.key} className="[content-visibility:visible]">
                {draw(e)}
              </MessageScrollerItem>
            ))}
          </StepsLoad.Provider>
          {tail}
          {status === "thinking" && !waiting && !turnWorking && (
            <Trace>
              <TraceLine status="running">
                <TraceTitle>Thinking</TraceTitle>
              </TraceLine>
            </Trace>
          )}
          {error && <ThreadError error={error} rows={list} onRetry={status === "idle" ? onRetry : undefined} onKeepHere={onKeepHere} />}
          <ThreadAnnouncer status={status} waiting={waiting} rows={list} who={who} />
        </MessageScrollerContent>
      </MessageScrollerViewport>
      <MessageScrollerButton
        onClick={() => {
          foldAtEnd.current = true;
        }}
        size="sm"
        className="gap-2 rounded-full px-3 shadow-float"
        aria-label={fresh > 0 ? `Jump to ${fresh} new ${fresh === 1 ? "message" : "messages"}` : "Jump to latest"}
      >
        <ArrowDownIcon data-icon="inline-start" />
        {fresh > 0 ? `${fresh} New` : "Latest"}
      </MessageScrollerButton>
    </MessageScroller>
  );
}

function useThreadWindow(
  list: TranscriptRow[],
  dividerAt: number | null,
  marks: ReadonlyArray<{ before: number; who: string; change: string; title: string }>,
  older: (() => void) | null,
) {
  const id = threadId(list);
  const [win, setWin] = useState(() => ({ id, start: openStart(list.length, dividerAt), first: list.length ? list[0] : null, above: 0 }));
  const shift = win.id !== id && win.first ? Math.max(0, list.indexOf(win.first)) : 0;
  const start = win.id === id || shift > 0 ? keepStart(win.start + shift, list.length, dividerAt) : openStart(list.length, dividerAt);
  const above = win.id === id ? win.above : shift > 0 ? win.above + shift : 0;
  if (win.id !== id || win.start !== start) setWin({ id, start, first: list.length ? list[0] : null, above });
  const asked = useRef<number | null>(null);
  const nearTop = (el: HTMLElement, beforeReveal: (el: HTMLElement) => void) => {
    const next = nextAbove(el, { hiddenAbove: start > 0, olderToAsk: older !== null && asked.current !== list.length });
    if (next === "far") asked.current = null;
    else if (next === "reveal") {
      beforeReveal(el);
      setWin(revealFrom(start));
    } else if (next === "older" && older) {
      asked.current = list.length;
      older();
    }
  };
  const reveal = useCallback(
    (query: string) => {
      const at = findStart(list, start, query, marks);
      if (at < start) flushSync(() => setWin((w) => (w.start <= at ? w : { ...w, start: at })));
    },
    [list, start, marks],
  );
  const fold = () => {
    const at = openStart(list.length, dividerAt);
    setWin((w) => (w.start === at ? w : { ...w, start: at }));
  };
  return { start, above, nearTop, reveal, fold };
}

function useRest(atRest: RefObject<() => void>, start: number, length: number) {
  const [rest] = useState(() =>
    restTimer(() => atRest.current(), { set: (run, ms) => window.setTimeout(run, ms), clear: (timer: number) => window.clearTimeout(timer) }),
  );
  useEffect(() => {
    rest.moved();
  }, [rest, start, length]);
  useEffect(() => rest.stop, [rest]);
  return rest;
}

function useFresh(list: TranscriptRow[], above: number): number {
  const { end: away } = useMessageScrollerScrollable();
  const [left, setLeft] = useState<{ at: number; above: number } | null>(null);
  if (away && !left) setLeft({ at: list.length, above });
  if (!away && left) setLeft(null);
  if (!left) return 0;
  return newSince(list, left.at + (above - left.above));
}

/**
 * Sending re-pins the thread to the bottom, as the phone's does, wherever the reader was. MessageScroller's own answer to a
 * send (scrolling your message to the top) counts every message it has not yet seen on screen as new, and a thread opens
 * at the bottom, so it jumped to the oldest one; no row is a scroll anchor, and this follows your message instead. A
 * queued message is not drawn in the thread, so sending one leaves the reader where they are.
 */
function useFollowSend(list: TranscriptRow[]) {
  const { scrollToEnd } = useMessageScroller();
  const tail = lastShown(list);
  const seen = useRef(tail);
  useEffect(() => {
    const sent = isNewSend(seen.current, tail);
    seen.current = tail;
    if (sent) scrollToEnd({ behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [tail, scrollToEnd]);
}
