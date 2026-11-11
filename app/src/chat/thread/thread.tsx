import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref, type UIEvent } from "react";
import { flushSync } from "react-dom";
import { ArrowDownIcon } from "lucide-react";
import type { TranscriptRow } from "../../../../core/attention/transcript.ts";
import { Button } from "@/ui/button";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScrollerScrollable,
} from "@/ui/message-scroller";
import { Trace, TraceLine, TraceTitle } from "@/ui/trace";
import type { ThreadHandle, ThreadProps } from "../conversation";
import { ThreadError } from "../thread-error";
import { StepsLoad } from "../tool-steps";
import { useArrivedFrom } from "../transcript";
import { REVEAL_PX, findStart, keepStart, openStart, revealStart, threadId } from "../transcript-window";
import { threadEntries, type ThreadEntry } from "./entries";
import { DayMarker, EventMarker, NewMarker, WidgetMarker } from "./thread-markers";
import { ThreadRow } from "./thread-row";
import { ThreadSteps } from "./thread-steps";

const EMPTY: TranscriptRow[] = [];

/**
 * The thread on loki's new components (plan 094, U5): shadcn's MessageScroller follows the bottom while you are there,
 * holds what you read when something above changes height or older rows arrive, and offers the way back to the latest.
 * Around it, loki's own window: a long thread mounts its newest rows and reveals older ones as you near the top, then
 * asks the Mac for older pages; find mounts what it needs before it searches. Behind Preferences › Appearance › New
 * thread (preview); today's thread stays the default.
 */
export const NewThread = forwardRef<ThreadHandle, Omit<ThreadProps, "previewable">>(function NewThread(props, ref) {
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
  older = null,
  loadFailed = null,
  loadStep,
  home = null,
  layout,
  tail,
  style,
  handle,
}: Omit<ThreadProps, "previewable"> & { handle: Ref<ThreadHandle> }) {
  const list = rows ?? EMPTY;
  const arrivedFrom = useArrivedFrom(rows);
  const dividerAt = layout?.dividerAt ?? null;
  const widgets = layout?.widgets ?? [];
  const { start, above, nearTop, reveal, fold } = useThreadWindow(list, dividerAt, widgets, older);
  const fresh = useFresh(list, above);
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
  const entries = rows
    ? threadEntries({ rows, from: start, above, dividerAt, dividerDay: layout?.dividerDay ?? null, widgets, busy: status !== "idle", arrivedFrom })
    : [];
  const draw = (e: ThreadEntry) => {
    switch (e.kind) {
      case "day":
        return <DayMarker label={e.label} />;
      case "new":
        return <NewMarker day={e.day} />;
      case "widget":
        return <WidgetMarker mark={e.mark} live={e.live} inline={layout?.inline} onFrame={layout?.onFrameWidget} onShowDesk={layout?.onShowDesk} />;
      case "steps":
        return <ThreadSteps rows={e.rows} running={e.running} arrived={e.arrived} />;
      case "event":
        return <EventMarker row={e.row} arrived={e.arrived} />;
      case "message":
        return (
          <ThreadRow
            row={e.row}
            last={e.last}
            streaming={status === "streaming" && e.last}
            first={e.first}
            arrived={e.arrived}
            agentName={who}
            onCancelQueued={e.row.queued && onCancelQueued ? cancelQueued : undefined}
          />
        );
    }
  };
  return (
    <MessageScroller data-new-thread className="flex-1">
      <MessageScrollerViewport preserveScrollOnPrepend onScroll={(ev: UIEvent<HTMLDivElement>) => nearTop(ev.currentTarget)} data-thread-scroll style={style}>
        <MessageScrollerContent className="gap-4 px-5 py-4 text-body text-foreground">
          {!rows && !loadFailed && <p className="m-0 text-meta text-muted-foreground">{home ? `loading from ${home}…` : "loading the thread…"}</p>}
          {!rows && loadFailed && (
            <div role="alert" className="flex items-center gap-2 text-meta text-destructive">
              <span>{home ? `could not load this chat from ${home}` : "could not load this chat"}</span>
              <Button size="sm" variant="outline" onClick={loadFailed}>
                try again
              </Button>
            </div>
          )}
          {rows?.length === 0 && <p className="m-0 text-meta text-muted-foreground">nothing here yet — everything you send lands in {who}'s transcript</p>}
          <StepsLoad.Provider value={stableLoadStep}>
            {entries.map((e) => (
              <MessageScrollerItem key={e.key} messageId={e.key} scrollAnchor={e.kind === "message" && e.anchor}>
                {draw(e)}
              </MessageScrollerItem>
            ))}
          </StepsLoad.Provider>
          {tail}
          {status === "thinking" && !waiting && (
            <Trace role="status">
              <TraceLine status="running">
                <TraceTitle>thinking</TraceTitle>
              </TraceLine>
            </Trace>
          )}
          {error && <ThreadError error={error} rows={list} onRetry={status === "idle" ? onRetry : undefined} />}
        </MessageScrollerContent>
      </MessageScrollerViewport>
      <MessageScrollerButton
        onClick={fold}
        size="sm"
        className="gap-1.5 rounded-full px-3 shadow-float"
        aria-label={fresh > 0 ? `jump to ${fresh} new ${fresh === 1 ? "message" : "messages"}` : "jump to latest"}
      >
        <ArrowDownIcon data-icon="inline-start" />
        {fresh > 0 ? `${fresh} new` : "latest"}
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
