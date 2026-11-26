import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { AccountLabel, OutsideSeed } from "../../../core/frame-types.ts";
import { offersAlways, type AttentionItem, type PendingApproval, type PendingQuestion } from "../../../core/attention/model.ts";
import type { Attachment } from "../../../core/attention/content.ts";
import { idOf } from "../../../core/attention/queue.ts";
import type { CardVia } from "../../../core/attention/use-attention.ts";
import type { WholeRow } from "../../../core/attention/transcript.ts";
import type { TranscriptRow } from "../chat/transcript";
import type { SuggestionsProps } from "../chat/suggestion-card";
import type { ModelEntry, ModelSelection, ReasoningEffort } from "../chat/model-picker";
import { freshSeeds } from "../workspace/outside-words";
import { spring } from "../kit/spring";
import { onScreenOffset, releaseVelocity, type Sample } from "../kit/let-go";
import {
  EMPTY_DECK,
  REFUSED,
  UNDO_MS,
  canCommit,
  commitCard,
  deckQueue,
  dragAxis,
  gestureFor,
  holdCard,
  makeMove,
  markOf,
  moveLedger,
  reconcileDeck,
  releaseDirection,
  reviewAnnouncement,
  stillTheCard,
  throughResting,
  undoCard,
  undoMove,
  type CardMark,
  type CardMoves,
  type DeckState,
  type Direction,
  type Move,
  type Origin,
  type PassSummary,
  type Refusal,
  type Via,
} from "./deck";

export interface FlowMoves extends CardMoves {
  laterAsks: (item: AttentionItem) => boolean;
  label: (item: AttentionItem, labelIds: string[], via?: CardVia) => Promise<string | null>;
  labelsOf: (item: AttentionItem) => Promise<AccountLabel[] | string>;
}

export interface CardView {
  rows: TranscriptRow[] | undefined;
  status: "idle" | "thinking" | "streaming";
  pending?: PendingApproval | null;
  question?: PendingQuestion | null;
  error?: string | null;
  older?: (() => void) | null;
  loadFailed?: (() => void) | null;
  loadStep?: (row: number) => Promise<WholeRow | null>;
}

export interface Deck {
  visible: AttentionItem[];
  current: AttentionItem | undefined;
  currentId: string | null;
  pass: PassSummary;
  heldId: string | null;
  commit: (item: AttentionItem, via: Via, from?: "gesture" | "menu") => boolean;
  undo: (item: AttentionItem, via: Via, wasHeld: boolean) => void;
  hold: (item: AttentionItem) => void;
  again: () => void;
  restingToo: () => void;
  resting: boolean;
}

export interface Undo {
  item: AttentionItem;
  via: Move;
  held: boolean;
}

export interface Leaving {
  item: AttentionItem;
  dir: Direction;
}

export interface Drag {
  dx: number;
  dy: number;
}

export interface Release {
  id: string;
  committed: boolean;
  dx: number;
  dy: number;
  v: number;
}

export interface CardHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
  onClickCapture: (e: ReactMouseEvent<HTMLElement>) => void;
}

export interface CardActions {
  onSend: (item: AttentionItem, text: string, images: Attachment[]) => void;
  onAnswer: (item: AttentionItem, requestId: string, answers: Record<string, string | string[]>) => void;
  onCancelQueued: (item: AttentionItem, text: string) => void;
  onStop?: (item: AttentionItem) => Promise<string | null>;
  model?: CardModel;
  suggestions?: Omit<SuggestionsProps, "rt">;
}

export interface CardModel {
  models: ModelEntry[] | null;
  onLoad: () => void;
  modelOf: (item: AttentionItem) => string | null;
  effortOf: (item: AttentionItem) => ReasoningEffort | null;
  onPick?: (item: AttentionItem, selection: ModelSelection) => Promise<void>;
}

export interface SeedsTaken {
  card: string | null;
  taken: readonly string[];
}

export function takeSeeds(now: SeedsTaken, card: string | null, seeds: readonly OutsideSeed[] | undefined): { next: SeedsTaken; lock: boolean } | null {
  const same = now.card === card;
  const taken = same ? now.taken : [];
  const fresh = freshSeeds(seeds, taken);
  if (same && fresh.length === 0) return null;
  return { next: { card, taken: [...taken, ...fresh.map((s) => s.id)] }, lock: fresh.length > 0 };
}

export function useDeck(items: AttentionItem[], all: AttentionItem[] = items): Deck {
  const [state, setState] = useState<DeckState>(EMPTY_DECK);
  const visible = useMemo(() => deckQueue(items, state), [items, state]);
  const current = visible.at(0);
  const reconciled = useMemo(() => reconcileDeck(state, items, all), [state, items, all]);
  if (reconciled !== state) setState(reconciled);
  return {
    visible,
    current,
    currentId: current ? idOf(current) : null,
    pass: state.pass,
    heldId: state.held ? idOf(state.held) : null,
    commit: (item, via, from = "gesture") => {
      if (!canCommit(item, via, from)) return false;
      setState((s) => commitCard(s, item, via, from));
      return true;
    },
    undo: (item, via, wasHeld) => setState((s) => undoCard(s, item, via, wasHeld)),
    hold: (item) => setState((s) => holdCard(s, item)),
    again: () => setState(EMPTY_DECK),
    restingToo: () => setState(throughResting),
    resting: state.resting,
  };
}

function useTimer() {
  const ref = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (ref.current) clearTimeout(ref.current);
    },
    [],
  );
  const clear = () => {
    if (ref.current) clearTimeout(ref.current);
  };
  const set = (fn: () => void, ms: number) => {
    clear();
    ref.current = setTimeout(fn, ms);
  };
  return { set, clear };
}

export function useDeckWidth(on: boolean) {
  const deckRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(360);
  useEffect(() => {
    const el = deckRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth || 360);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [on]);
  return { deckRef, width };
}

const isMove = (via: Via): via is Move => via === "seen" || via === "later" || via === "archive";

export function usePass({
  deck,
  reduced,
  moves,
  onNote,
  onAsk,
  onCommit,
}: {
  deck: Deck;
  reduced: boolean;
  moves: CardMoves;
  onNote: (text: string) => void;
  onAsk: (item: AttentionItem, how: "swipe" | "tap") => void;
  onCommit: (item: AttentionItem) => void;
}) {
  const [leaving, setLeaving] = useState<Leaving | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [refused, setRefused] = useState(false);
  const [said, setSaid] = useState("");
  const undoTimer = useTimer();
  const leaveTimer = useTimer();
  const refuseTimer = useTimer();
  const [ledger] = useState(moveLedger);

  const flashRefused = (why: Refusal) => {
    setRefused(true);
    setSaid(REFUSED[why]);
    refuseTimer.set(() => setRefused(false), 420);
  };
  const bringBack = (item: AttentionItem, via: Move, held: boolean) => {
    ledger.takenBack(idOf(item));
    deck.undo(item, via, held);
    setLeaving((l) => (l && idOf(l.item) === idOf(item) ? null : l));
    setUndo((u) => (u && idOf(u.item) === idOf(item) ? null : u));
  };
  const commit = (item: AttentionItem, via: Via, how: "swipe" | "tap" = "tap", opts: { until?: string; done?: boolean; from?: "gesture" | "menu" } = {}) => {
    const held = deck.heldId === idOf(item);
    onCommit(item);
    if (!deck.commit(item, via, opts.from)) {
      flashRefused(item.pendingApproval ? "decide" : item.outside ? "jira" : "main");
      return;
    }
    const move = ledger.made(idOf(item));
    if (isMove(via) && !opts.done)
      void makeMove(moves, item, via, how, opts.until).then((r) => {
        if ((!r.error && !r.ask) || !ledger.stands(idOf(item), move)) return;
        bringBack(item, via, held);
        if (r.error) onNote(r.error);
        else onAsk(item, how);
      });
    const rest = deck.visible.filter((i) => idOf(i) !== idOf(item));
    setSaid(reviewAnnouncement(via, rest[0], rest.length));
    if (!reduced) {
      setLeaving({ item, dir: via === "archive" ? "up" : via === "later" || via === "deny" ? "left" : "right" });
      leaveTimer.set(() => setLeaving((l) => (l && idOf(l.item) === idOf(item) ? null : l)), spring("smooth").ms + 30);
    }
    undoTimer.clear();
    if (isMove(via)) {
      setUndo({ item, via, held });
      undoTimer.set(() => setUndo(null), UNDO_MS);
    } else setUndo(null);
  };
  const undoLast = () => {
    if (!undo) return;
    const { item, via, held } = undo;
    undoTimer.clear();
    ledger.takenBack(idOf(item));
    deck.undo(item, via, held);
    setLeaving(null);
    setUndo(null);
    setSaid(`Undone. ${item.title ?? item.id} is back.`);
    void undoMove(moves, item).then((err) => {
      if (!err) return;
      deck.commit(item, via);
      onNote(err);
    });
  };
  return { leaving, undo, refused, said, commit, undoLast, flashRefused };
}

const OWN_GESTURE = "textarea, input, select, button, a, pre, summary, [data-attachments], [data-question]";
const HANDLE = "[data-reply-handle]";

/**
 * Pointer Events on the top card (touch and mouse alike). The body takes only sideways drags past the
 * slop, so the thread inside still scrolls (pan-y hands vertical pans to the browser, which then
 * cancels our pointer). The folded reply box is a handle that also drags up; it is checked before the
 * controls that otherwise keep their own gestures. Owns the drag offset and the velocity samples.
 */
export function useSwipe({
  width,
  typed,
  sending,
  current,
  onCommit,
  onRefuse,
}: {
  width: number;
  typed: boolean;
  sending: boolean;
  current: AttentionItem | undefined;
  onCommit: (item: AttentionItem, via: Via) => void;
  onRefuse: (why: Refusal) => void;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const [release, setRelease] = useState<Release | null>(null);
  const start = useRef<{
    x: number;
    y: number;
    id: number;
    origin: Origin;
    card: CardMark | null;
    dragging: boolean;
    base: Drag;
    xs: Sample[];
    ys: Sample[];
  } | null>(null);
  const dragged = useRef(false);
  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    dragged.current = false;
    const target = e.target as Element;
    const origin: Origin = target.closest(HANDLE) && !target.closest("button") ? "box" : "body";
    if (origin === "body" && target.closest(OWN_GESTURE)) return;
    start.current = {
      x: e.clientX,
      y: e.clientY,
      id: e.pointerId,
      origin,
      card: current ? markOf(current) : null,
      dragging: false,
      base: { dx: 0, dy: 0 },
      xs: [{ at: e.clientX, t: e.timeStamp }],
      ys: [{ at: e.clientY, t: e.timeStamp }],
    };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const s = start.current;
    if (s?.id !== e.pointerId) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (!s.dragging) {
      if (!dragAxis(dx, dy, s.origin)) return;
      s.dragging = true;
      s.base = { dx: onScreenOffset(e.currentTarget, "x"), dy: onScreenOffset(e.currentTarget, "y") };
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {}
    }
    s.xs.push({ at: e.clientX, t: e.timeStamp });
    s.ys.push({ at: e.clientY, t: e.timeStamp });
    if (s.xs.length > 12) s.xs.shift();
    if (s.ys.length > 12) s.ys.shift();
    setDrag({ dx: dx + s.base.dx, dy: s.origin === "box" ? Math.min(0, dy + s.base.dy) : 0 });
  };
  const finish = (e: ReactPointerEvent<HTMLElement>, cancelled: boolean) => {
    const s = start.current;
    if (s?.id !== e.pointerId) return;
    start.current = null;
    if (!s.dragging) return;
    dragged.current = true;
    setTimeout(() => {
      dragged.current = false;
    }, 0);
    const dx = e.clientX - s.x + s.base.dx;
    const dy = s.origin === "box" ? Math.min(0, e.clientY - s.y + s.base.dy) : 0;
    const vx = cancelled ? 0 : releaseVelocity(s.xs, e.timeStamp) / 1000;
    const vy = cancelled || s.origin !== "box" ? 0 : releaseVelocity(s.ys, e.timeStamp) / 1000;
    const same = stillTheCard(s.card, current);
    const dir = cancelled || !current || !same ? null : releaseDirection(dx, dy, width, vx, vy, s.origin);
    const gesture = dir && current ? gestureFor(current, dir, { typed, sending }) : null;
    const via = gesture && "via" in gesture ? gesture.via : null;
    if (current) setRelease({ id: idOf(current), committed: !!via, dx, dy, v: dir === "up" ? vy : vx });
    if (cancelled || !current) {
      setDrag(null);
      return;
    }
    if (via) onCommit(current, via);
    else {
      setDrag(null);
      if (gesture && "refused" in gesture) onRefuse(gesture.refused);
    }
  };
  const handlers: CardHandlers = {
    onPointerDown,
    onPointerMove,
    onPointerUp: (e) => finish(e, false),
    onPointerCancel: (e) => finish(e, true),
    onClickCapture: (e) => {
      if (!dragged.current) return;
      dragged.current = false;
      e.stopPropagation();
      e.preventDefault();
    },
  };
  return { drag, release, clear: () => setDrag(null), handlers };
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

export { offersAlways };
