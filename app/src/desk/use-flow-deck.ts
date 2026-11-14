import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import { inLane, laneItems, type ResolvedLane } from "../../../core/attention/lanes.ts";
import { idOf, inboxQueue, type Decision } from "../../../core/attention/queue.ts";
import { rowAfter, type DeckMoveApi } from "./deck-moves";
import { useDeckActions } from "./use-deck-actions";
import { useDeckQueue } from "./use-deck-queue";

/**
 * Called when a Flow visit that decided something ends: how many cards each action took, the replies, the cards shown
 * and how long the visit lasted (in milliseconds), for analytics.
 */
export type PassSummaryHandler = (pass: {
  decided: number;
  next: number;
  archive: number;
  approve: number;
  deny: number;
  replies: number;
  shown: number;
  duration_ms: number;
}) => void;

/** What a visit has done when it ends, and who hears of it. */
export interface VisitTally {
  decided: Decision[];
  replies: number;
  onPass?: PassSummaryHandler;
}

/**
 * One visit's own tally (plan 2026-11-14-1330, KTD6): the cards shown, each counted once and only as a committed
 * selection, so arrowing past a row does not count it; and its end, which reports once however many ways it ends
 * (leaving the place, the page unloading). `now` is the clock, injected so a test can fix the duration.
 */
export function createVisit(began: number, now: () => number = Date.now) {
  const shown = new Set<string>();
  let ended = false;
  return {
    /** A card became the selection. */
    show(id: string) {
      shown.add(id);
    },
    /** The visit is over: report it, unless it already was or it did nothing. */
    end({ decided, replies, onPass }: VisitTally) {
      if (ended) return;
      ended = true;
      if (!onPass || (!decided.length && !replies)) return;
      const by = (via: Decision["via"]) => decided.filter((x) => x.via === via).length;
      onPass({
        decided: decided.length,
        next: by("next"),
        archive: by("archive"),
        approve: by("approve"),
        deny: by("deny"),
        replies,
        shown: shown.size,
        duration_ms: now() - began,
      });
    },
  };
}

/**
 * End the visit when the page unloads (`pagehide`), so quitting the app still reports it. Hiding or minimising the
 * window is not leaving Flow, so nothing listens for that. Returns the unsubscribe.
 */
export function endOnPageHide(page: Pick<EventTarget, "addEventListener" | "removeEventListener">, end: () => void): () => void {
  page.addEventListener("pagehide", end);
  return () => page.removeEventListener("pagehide", end);
}

/**
 * Whether the selected card was answered elsewhere (R11): it has left the Inbox, archived or answered on the phone or
 * another Mac, while the selection holds it. A chat the person replied to or answered here (`touched`) is only waiting
 * for its agent's turn, which is no answer from elsewhere, so its moves stay.
 */
export function answeredElsewhere(item: AttentionItem, items: readonly AttentionItem[], resting: boolean, touched: ReadonlySet<string>): boolean {
  const id = idOf(item);
  const now = items.find((i) => idOf(i) === id);
  if (now && inboxQueue([now], resting).length > 0) return false;
  return !(now?.status === "running" && touched.has(id));
}

/**
 * The visit's rows as their cards are now: the queue keeps its own objects for the rows that stay, so its identity says
 * whether anything moved, and a row draws the live item of the same id instead, so a new message updates its preview,
 * time and unread mark. A row whose card left the items keeps the queue's.
 */
export function liveRows(queue: readonly AttentionItem[], live: ReadonlyMap<string, AttentionItem>): AttentionItem[] {
  return queue.map((i) => live.get(idOf(i)) ?? i);
}

/** What the Flow deck reads from the app: the cards, the lane, the moves out there and the visit's listeners. */
export interface FlowDeckOptions {
  /** Every card in Flow, whatever the lane: the deck reads the lane's (KTD3). */
  items: AttentionItem[];
  /** This device's active lane, null for Everything (plan 087). */
  lane: ResolvedLane | null;
  moves: DeckMoveApi;
  /** Sign In… on a refusal's notice: open where the card's account is mended. */
  onSignIn?: () => void;
  /** The visit ended (KTD6): what it did, for analytics. */
  onPass?: PassSummaryHandler;
  /** A card became the selection (analytics: its dwell clock starts). */
  onShown?: (item: AttentionItem) => void;
  /** Fetch a chat card's thread once it is selected. */
  loadHistory: (item: AttentionItem) => void;
}

/**
 * The Flow deck (plan 2026-11-14-1330, KTD5): the visit's rows, the selected card, the decisions, the badge's flash and
 * the reply box, held once so a list and a detail can share them. The selection is a card's id that falls back to the
 * first row, as Learn's deck does (recall/use-deck-pass.ts). Mounted from entering the Flow place until leaving it,
 * which is the visit: leaving, or the page unloading, ends it and reports it (KTD6).
 */
export function useFlowDeck({ items, lane, moves, onSignIn, onPass, onShown, loadHistory }: FlowDeckOptions) {
  /** The cards the active lane holds: only they come up (R13). */
  const shown = useMemo(() => laneItems(items, lane), [items, lane]);
  /** Going through the cards Next rested, asked for at the end of the pass. */
  const [resting, setResting] = useState(false);
  const { queue, setQueue, decided: allDecided, setDecided, selected: row, select, selectedNow } = useDeckQueue(shown, lane, resting);
  // What undo takes back and the summary shows: the visit's moves on cards this lane holds (KTD6).
  const decided = lane ? allDecided.filter((d) => inLane(d.item, lane)) : allDecided;
  const live = useMemo(() => new Map(items.map((i) => [idOf(i), i])), [items]);
  const rows = useMemo(() => liveRows(queue, live), [queue, live]);
  /** Chats the person replied to or answered in this visit: their agent's turn is not an answer from elsewhere. */
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());

  const current = row ? (live.get(idOf(row)) ?? row) : undefined;
  const elsewhere = !!current && answeredElsewhere(current, shown, resting, touched);
  /** The card the moves act on, read at the press: none while the selection holds a card answered elsewhere. */
  const actionable = () => {
    const at = selectedNow();
    const item = at ? (live.get(idOf(at)) ?? at) : undefined;
    return item && !answeredElsewhere(item, shown, resting, touched) ? item : undefined;
  };
  const actions = useDeckActions({ current, selected: actionable, queue, select, decided: allDecided, lane, setDecided, setQueue, moves, onSignIn });

  /** A reply or an answer went from here on this card's chat. */
  const touch = (item: AttentionItem) => {
    const id = idOf(item);
    setTouched((t) => (t.has(id) ? t : new Set(t).add(id)));
  };
  /** The card leaves this visit without a decision (handed off): the row after it is selected when it was. */
  const remove = (item: AttentionItem) => {
    const id = idOf(item);
    if (current && idOf(current) === id) select(rowAfter(queue, id));
    setQueue((q) => q.filter((i) => idOf(i) !== id));
  };

  // The visit, from mounting (entering Flow) to unmounting (leaving it) or the page unloading.
  const [visit] = useState(() => createVisit(Date.now()));
  const tally = useRef<VisitTally>({ decided: allDecided, replies: actions.replies, onPass });
  useEffect(() => {
    tally.current = { decided: allDecided, replies: actions.replies, onPass };
  });
  useEffect(() => {
    const end = () => visit.end(tally.current);
    const stop = endOnPageHide(window, end);
    return () => {
      stop();
      end();
    };
  }, [visit]);

  // Analytics: each card that becomes the selection, once per stay there (a card gets there many ways: an effect, not a handler).
  const currentId = current ? idOf(current) : null;
  const cardShown = useEffectEvent((id: string) => {
    if (!current) return;
    visit.show(id);
    onShown?.(current);
  });
  useEffect(() => {
    if (currentId) cardShown(currentId);
  }, [currentId]);

  // Fetch the thread once when a card becomes the selection; live rows stream in on top of it.
  const loadCurrent = useEffectEvent(() => {
    // An outside card (plan 067) carries its own lines: there is no chat thread to fetch.
    if (current && !current.outside) loadHistory(current);
  });
  useEffect(() => loadCurrent(), [currentId]);

  return {
    /** The lane's cards. */
    shown,
    /** The visit's rows, in the list's order. */
    queue,
    /** The same rows as their cards are now, for drawing the list. */
    rows,
    /** The selected card, as it is now. */
    current,
    /** The selected card was answered elsewhere: it stays, its moves off, until the selection leaves it (R11). */
    elsewhere,
    select,
    /** The visit's decisions on cards this lane holds. */
    decided,
    resting,
    /** Go Through Them: the cards Next rested come in, sorted afresh. */
    goThrough: () => setResting(true),
    actions,
    touch,
    remove,
  };
}

/** The Flow deck, as `useFlowDeck` holds it. */
export type FlowDeck = ReturnType<typeof useFlowDeck>;
