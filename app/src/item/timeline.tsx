import { Thought } from "./thought";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref, type UIEvent } from "react";
import { flushSync } from "react-dom";
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
import { StepsLoad } from "../chat/tool-steps";
import { useArrivedFrom } from "../chat/transcript";
import { REVEAL_PX, findStart, keepStart, openStart, revealStart, threadId } from "../chat/transcript-window";
import { threadEntries, threadTurns, type TurnPart } from "./entries";
import { WidgetArtifact } from "./content-parts";
import { ChangeEntry, DayMarker, EventEntry, NewMarker } from "./event-entry";
import { chatEntries, type ItemEntry } from "./item-view";
import { ChatMessage } from "./message-entry";
import { Work, samePlan, stretchPlan } from "./work";
import { AgentTurn } from "./agent-turn";
import { useLook } from "../theme";

/** Liquid Glass tells the time before your message when this long has passed since the row before (entries.ts, U14). */
const TIME_GAP = 15 * 60_000;

const EMPTY: TranscriptRow[] = [];

/**
 * The Timeline (plan 097; plan 096, U5): every entry of the item in order, as Turns for a chat. shadcn's MessageScroller follows the bottom while you are there,
 * holds what you read when something above changes height or older rows arrive, and offers the way back to the latest.
 * Around it, loki's own window: a long thread mounts its newest rows and reveals older ones as you near the top, then
 * asks the Mac for older pages; find mounts what it needs before it searches. Behind Preferences › Appearance › New
 * chat pane (preview); today's thread stays the default.
 */
export const Timeline = forwardRef<ThreadHandle, Omit<ThreadProps, "previewable">>(function Timeline(props, ref) {
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
}: Omit<ThreadProps, "previewable"> & { handle: Ref<ThreadHandle> }) {
  const list = rows ?? EMPTY;
  const glass = useLook() === "glass";
  const arrivedFrom = useArrivedFrom(rows);
  const dividerAt = layout?.dividerAt ?? null;
  const widgets = layout?.widgets ?? [];
  const { start, above, nearTop, reveal, fold } = useThreadWindow(list, dividerAt, widgets, older);
  const fresh = useFresh(list, above);
  useFollowSend(list);
  useImperativeHandle(
    handle,
    () => ({
      // The scroller stops following once the reader is away from the bottom, which find's selection already moves them.
      unpin: () => {},
      reveal,
    }),
    [reveal],
  );
  // Stable handlers for the memoised rows and the step loader, as today's thread keeps them.
  const cancelRef = useRef(onCancelQueued);
  const stepRef = useRef(loadStep);
  useEffect(() => {
    cancelRef.current = onCancelQueued;
    stepRef.current = loadStep;
  }, [onCancelQueued, loadStep]);
  const cancelQueued = useCallback((row: TranscriptRow) => cancelRef.current?.(row.text), []);
  const stableLoadStep = useCallback((row: number) => stepRef.current?.(row) ?? Promise.resolve(null), []);

  const who = layout?.people?.assistant.name ?? agentName ?? "the agent";
  // Messages queued mid-turn wait in the Composer's queue (plan 097, U6), not at the end of the thread.
  // The agent's live reply can follow a queued message, so every queued row is left out, not only a trailing run.
  const shown = rows?.some((r) => r.queued) ? rows.filter((r) => !r.queued) : rows;
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
            gaps: glass ? TIME_GAP : undefined,
          }),
          { busy: status !== "idle", waiting },
        ),
      )
    : [];
  // A plan that repeats unchanged from the stretch before folds to a line; only a plan that moved is drawn whole.
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
  // The live turn's badge already says it is working; the thinking line is for the wait before its first part.
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
  // The agent paused on the person (an approval or a question): its last call has not come back, and the chat reads
  // idle while it waits, so the stretch is marked by that rather than by the status (plan 097, KTD6).
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
          <>
            <Thought rows={p.rows} />
            <Work rows={p.rows} running={p.running || paused(p.rows)} arrived={p.arrived} waiting={paused(p.rows)} planAsBefore={repeated.has(p.key)} />
          </>
        );
      case "event":
        return <EventEntry row={p.row} arrived={p.arrived} />;
      case "message":
        return (
          <>
            <Thought rows={[p.row]} />
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
      // A chat has no outside messages or field changes; the outside item's own timeline draws them (plan 097, U7).
      case "message":
        return null;
      case "event":
        return <ChangeEntry who={e.who} text={e.text} at={e.at} />;
      case "turn":
        return <AgentTurn agentName={who} state={e.state} failed={e.failed} took={e.took} parts={e.parts} draw={part} />;
    }
  };
  return (
    <MessageScroller data-new-thread className="flex-1">
      <MessageScrollerViewport preserveScrollOnPrepend onScroll={(ev: UIEvent<HTMLDivElement>) => nearTop(ev.currentTarget)} data-thread-scroll style={style}>
        <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-5 px-6 py-5 text-body text-foreground">
          {!rows && !loadFailed && <p className="m-0 text-meta text-muted-foreground">{home ? `loading from ${home}…` : "loading the thread…"}</p>}
          {!rows && loadFailed && (
            <div role="alert" className="flex items-center gap-2 text-meta text-destructive">
              <span>{home ? `could not load this chat from ${home}` : "could not load this chat"}</span>
              <Button size="sm" variant="outline" onClick={loadFailed}>
                try again
              </Button>
            </div>
          )}
          {rows?.length === 0 && !blank && (
            <p className="m-0 text-meta text-muted-foreground">nothing here yet — everything you send lands in {who}'s transcript</p>
          )}
          <StepsLoad.Provider value={stableLoadStep}>
            {entries.map((e) => (
              <MessageScrollerItem key={e.key} messageId={e.key}>
                {draw(e)}
              </MessageScrollerItem>
            ))}
          </StepsLoad.Provider>
          {tail}
          {status === "thinking" && !waiting && !turnWorking && (
            <Trace role="status">
              <TraceLine status="running">
                <TraceTitle>thinking</TraceTitle>
              </TraceLine>
            </Trace>
          )}
          {error && <ThreadError error={error} rows={list} onRetry={status === "idle" ? onRetry : undefined} onKeepHere={onKeepHere} />}
        </MessageScrollerContent>
      </MessageScrollerViewport>
      <MessageScrollerButton
        onClick={fold}
        size="sm"
        className="gap-1.5 rounded-full px-3 shadow-float"
        aria-label={fresh > 0 ? `jump to ${fresh} new ${fresh === 1 ? "message" : "messages"}` : "jump to latest"}
      >
        <ArrowDownIcon data-icon="inline-start" />
        {/* Title case under Liquid Glass, as a Mac button says it (U19). */}
        {fresh > 0 ? `${fresh} ${glass ? "New" : "new"}` : glass ? "Latest" : "latest"}
      </MessageScrollerButton>
    </MessageScroller>
  );
}

/** The window over a long thread (transcript-window.ts): its first mounted row, how many rows arrived above, and its moves. */
function useThreadWindow(
  list: TranscriptRow[],
  dividerAt: number | null,
  marks: ReadonlyArray<{ before: number; who: string; change: string; title: string }>,
  older: (() => void) | null,
) {
  const id = threadId(list);
  const [win, setWin] = useState(() => ({ id, start: openStart(list.length, dividerAt), first: list.length ? list[0] : null, above: 0 }));
  // Older history loaded above: the old first row sits further down by as many rows as arrived.
  const shift = win.id !== id && win.first ? Math.max(0, list.indexOf(win.first)) : 0;
  const start = win.id === id || shift > 0 ? keepStart(win.start + shift, list.length, dividerAt) : openStart(list.length, dividerAt);
  const above = win.id === id ? win.above : shift > 0 ? win.above + shift : 0;
  if (win.id !== id || win.start !== start) setWin({ id, start, first: list.length ? list[0] : null, above });
  // One ask for older history per page: the thread's length when asked.
  const asked = useRef<number | null>(null);
  const nearTop = (el: HTMLElement) => {
    if (el.clientHeight === 0 || el.scrollTop >= REVEAL_PX) {
      // Away from the top, the next visit asks again: a page that failed added no rows.
      asked.current = null;
      return;
    }
    if (start > 0) setWin((w) => ({ ...w, start: revealStart(w.start) }));
    else if (older && asked.current !== list.length) {
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
  // Back at the latest, the window folds to the newest rows again.
  const fold = () => setWin((w) => ({ ...w, start: openStart(list.length, dividerAt) }));
  return { start, above, nearTop, reveal, fold };
}

/**
 * How many messages came in since the reader left the bottom, for the jump button. Counted from the thread's length at
 * the moment the scroller first had more below; rows loaded above move that mark with them.
 */
function useFresh(list: TranscriptRow[], above: number): number {
  const { end: away } = useMessageScrollerScrollable();
  const [left, setLeft] = useState<{ at: number; above: number } | null>(null);
  if (away && !left) setLeft({ at: list.length, above });
  if (!away && left) setLeft(null);
  if (!left) return 0;
  const from = left.at + (above - left.above);
  return list.slice(from).filter((r) => r.role === "user" || r.role === "assistant").length;
}

/**
 * Sending re-pins the thread to the bottom, as today's does, wherever the reader was. MessageScroller's own answer to a
 * send (scrolling your message to the top) counts every message it has not yet seen on screen as new, and a thread opens
 * at the bottom, so it jumped to the oldest one; no row is a scroll anchor, and this follows your message instead.
 */
function useFollowSend(list: TranscriptRow[]) {
  const { scrollToEnd } = useMessageScroller();
  const tail = list.length ? list[list.length - 1] : null;
  const seen = useRef(tail);
  useEffect(() => {
    if (tail === seen.current) return;
    const sent = tail?.role === "user" && seen.current !== null;
    seen.current = tail;
    if (sent) scrollToEnd({ behavior: "smooth" });
  }, [tail, scrollToEnd]);
}
