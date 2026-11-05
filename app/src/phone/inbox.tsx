import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { LabelView } from "../../../core/labels.ts";
import { LabelChips } from "../chat/labels";
import type { AttentionItem, PendingApproval, PendingQuestion } from "../../../core/attention/model.ts";
import type { Attachment } from "../../../core/attention/content.ts";
import { catchUpQueue, idOf, restingCount } from "../../../core/attention/queue.ts";
import { useConversation, type ChatViews, type HandoffSource, type OutsideSource } from "../../../core/attention/use-attention.ts";
import { OpenChat, type TranscriptRow } from "../chat/transcript";
import { openConversation } from "./router";
import type { WholeRow } from "../../../core/attention/transcript.ts";
import { Conversation, Thread } from "../chat/conversation";
import { bumpTick, chipText, tickOf, waitingCount, type ChatTick, type SuggestionsProps } from "../chat/suggestion-card";
import type { ModelEntry, ModelSelection, ReasoningEffort } from "../chat/model-picker";
import { avatarUrl } from "../desk/env";
import { Button, sentence } from "../components";
import { waitingSince } from "./model";
import { Icon } from "./icons";
import { Avatar, SkeletonCard } from "./rows";
import { useMessageActions } from "./use-message-actions";
import { draftKey, useDraft } from "../shared/drafts";
import { TopBar } from "./ui";
import { ThreadNotice, replyPlaceholder, useThreadLayout } from "./thread-parts";
import { openFromCard } from "./transitions";
import { OutsideReply, OutsideThread, disconnectedText, outsideTitle, outsideWho, senderName, useOutsideThread, wentTo } from "../desk/outside-card";
import { HandoffPicker } from "../desk/handoff-picker";
import { spring } from "../kit/spring";
import { useLeave } from "../kit/leave";
import { onScreenOffset, releaseVelocity, type Sample } from "../kit/let-go";
import {
  DRAG_SLOP,
  EMPTY_DECK,
  FLY_PAST,
  UNDO_MS,
  armed,
  canCommit,
  cardNotice,
  cardsToDraw,
  commitCard,
  deckQueue,
  flingVelocity,
  holdCard,
  isDismissed,
  isHorizontalDrag,
  moveLedger,
  reconcileDeck,
  refusedOffset,
  revealOpacity,
  reviewAnnouncement,
  rotationFor,
  stackPose,
  summaryLine,
  swipeDecision,
  throughResting,
  undoCard,
  makeMove,
  undoMove,
  type CardMoves,
  type DeckState,
  type Move,
  type PassSummary,
  type Role,
  type Swipe,
  type Via,
} from "./deck";
import type { CardVia } from "../../../core/attention/use-attention.ts";
import type { AccountLabel } from "../../../core/frame-types.ts";
import { ReturnTimeSheet } from "./return-time-sheet";
import { MailLabelsSheet } from "./mail-labels-sheet";

/**
 * The inbox as a review pass, the way Slack's Catch Up works on a phone: one card at a time, the next
 * one or two peeking from behind, "N Left" on top. The card is the conversation itself — who it is
 * with, the thread with the unread line, what the agent waits on, and a working message box — so a card
 * can be read and answered without leaving the Inbox; an outside card (plan 067) shows its thread's messages
 * instead, with its reply box. Every card moves the same way (plan 070, R10): a right swipe or Read marks it read,
 * here and in Gmail or Slack, and rests it; a left swipe or Later leaves it unread and brings it back after its
 * return time, and the second Later in a row asks when, in a sheet; Archive (done) is a button only, and an email
 * card has Label beside it, a sheet of its Gmail labels. Approvals refuse every swipe, and the buttons become Deny and
 * Approve; a card whose reply box holds text refuses swipes too, so nothing goes by accident. Undo sits in the top bar
 * for six seconds after Read, Later or Archive and takes the move back out there as well. The pure parts (when a drag
 * commits, the lean, the pass itself, the moves, what the card says) are in deck.ts.
 */

/**
 * What the Inbox does to cards, useAttention's moves (plan 070, U6): read, later, archive and undo, whether a Later
 * would ask when, and an email card's Gmail labels.
 */
export interface InboxMoves extends CardMoves {
  laterAsks: (item: AttentionItem) => boolean;
  label: (item: AttentionItem, labelIds: string[], via?: CardVia) => Promise<string | null>;
  labelsOf: (item: AttentionItem) => Promise<AccountLabel[] | string>;
}

/** What the deck needs of a conversation to draw it inside a card (useAttention's `conversation`). */
export interface CardView {
  rows: TranscriptRow[] | undefined;
  status: "idle" | "thinking" | "streaming";
  pending?: PendingApproval | null;
  question?: PendingQuestion | null;
  error?: string | null;
  older?: (() => void) | null;
  /** The thread's first page did not come (plan 041): try again. */
  loadFailed?: (() => void) | null;
  /** Fetch what a history page left out of a lean row: a tool row's step (plan 041), an event's detail (plan 043). */
  loadStep?: (row: number) => Promise<WholeRow | null>;
}

/**
 * A pass, held by the parent (phone.tsx) beside the transcripts it fetches for the top card, so it
 * survives the Inbox being out of sight: the cards in order, the one on top, the tally, and the card
 * held after a reply. `commit` is false when the card refuses that way off (any but a decision on an approval, Archive on a main chat).
 */
export interface Deck {
  visible: AttentionItem[];
  current: AttentionItem | undefined;
  currentId: string | null;
  pass: PassSummary;
  /** The card kept in hand after a reply from it (deck.ts DeckState.held). */
  heldId: string | null;
  commit: (item: AttentionItem, via: Via) => boolean;
  undo: (item: AttentionItem, via: Via, wasHeld: boolean) => void;
  /** Something went out from this card: keep it on top until it is decided. */
  hold: (item: AttentionItem) => void;
  /**
   * Whether the card was sent away at its current stamp, read from the pass as it is now (not as it was when a caller's
   * closure was made), so a reply resolving late does not take a card off a second time.
   */
  dismissed: (item: AttentionItem) => boolean;
  /** A fresh visit: the cards moved past in this one come back. */
  again: () => void;
  /** Go through the cards Read rested. */
  restingToo: () => void;
  /** Whether this visit goes through them already. */
  resting: boolean;
}

/** The phone Inbox's pass (see `Deck`), kept in the parent so it lasts while the Inbox is out of sight. */
export function useDeck(items: AttentionItem[]): Deck {
  const [state, setState] = useState<DeckState>(EMPTY_DECK);
  const visible = useMemo(() => deckQueue(items, state), [items, state]);
  const current = visible.at(0);
  // Pin whatever is on top, drop dismissals the live list has outgrown (the same state when nothing moved).
  const reconciled = useMemo(() => reconcileDeck(state, items), [state, items]);
  if (reconciled !== state) setState(reconciled);
  // The pass as last drawn, for `dismissed`: a reply's send captures the deck of the render it started in.
  const live = useRef(state);
  useLayoutEffect(() => {
    live.current = state;
  });
  return {
    visible,
    current,
    currentId: current ? idOf(current) : null,
    pass: state.pass,
    heldId: state.held ? idOf(state.held) : null,
    commit: (item, via) => {
      if (!canCommit(item, via)) return false;
      setState((s) => commitCard(s, item, via));
      return true;
    },
    undo: (item, via, wasHeld) => setState((s) => undoCard(s, item, via, wasHeld)),
    hold: (item) => setState((s) => holdCard(s, item)),
    dismissed: (item) => isDismissed(live.current, item),
    again: () => setState(EMPTY_DECK),
    restingToo: () => setState(throughResting),
    resting: state.resting,
  };
}

/** One timeout at a time: `set` replaces whatever is pending, `clear` drops it, and unmount drops it too. */
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

/** The card's width decides the commit distance and the lean: the deck's box, measured live; 360 until it is on screen. */
function useDeckWidth(on: boolean) {
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

interface Undo {
  item: AttentionItem;
  via: Move;
  held: boolean;
}
/** The card on its way off, and which way it goes. */
interface Leaving {
  item: AttentionItem;
  dir: 1 | -1;
}

const UNDO_NAME: Record<Move, string> = { seen: "Undo Read", later: "Undo Later", archive: "Undo Archive" };

/** Undo in the top bar: it springs in (phone.css) and, when its seconds run out or it is used, shrinks away. */
function UndoButton({ via, onUndo }: { via: Move; onUndo: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useLeave(ref, UNDO_LEAVE, 180);
  return (
    <button ref={ref} type="button" className="loki-phone-undo" onClick={onUndo} aria-label={UNDO_NAME[via]}>
      Undo
    </button>
  );
}
const UNDO_LEAVE: Keyframe[] = [{ opacity: 1 }, { opacity: 0, transform: "scale(0.8)" }];

const isMove = (via: Via): via is Move => via === "seen" || via === "later" || via === "archive";

/** Why a card refused to go: the reason a screen reader hears. */
type Refusal = "approval" | "main" | "typed" | "sending";
const REFUSED: Record<Refusal, string> = {
  approval: "This one needs Approve or Deny.",
  main: "A main chat cannot be archived.",
  typed: "Send the reply first, or use the buttons.",
  sending: "The reply is still sending.",
};

/**
 * What a pass does on screen as cards go: the card flying off (on the smooth spring, unless motion is reduced),
 * the Undo button's card (for UNDO_MS after Read, Later or Archive), the flash when a card refuses that way off,
 * and the sentence a screen reader hears. `commit` takes the card off at once and makes its move out there through
 * `moves`; a move that fails brings the card back with its reason (`onNote`), and a Later that must ask when brings it
 * back and asks (`onAsk`). `done` is for a move already made, as a sent reply's read. `undoLast` puts the last one back,
 * out there too.
 */
function usePass({
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
  // Which move on each card still stands: a write-back that fails after Undo, or under a newer move, brings nothing back.
  const [ledger] = useState(moveLedger);

  const flashRefused = (why: Refusal) => {
    setRefused(true);
    setSaid(REFUSED[why]);
    refuseTimer.set(() => setRefused(false), 420);
  };
  /** The card returns on top as it was before `via`, and the Undo for it goes. */
  const bringBack = (item: AttentionItem, via: Move, held: boolean) => {
    ledger.takenBack(idOf(item));
    deck.undo(item, via, held);
    setLeaving((l) => (l && idOf(l.item) === idOf(item) ? null : l));
    setUndo((u) => (u && idOf(u.item) === idOf(item) ? null : u));
  };
  const commit = (item: AttentionItem, via: Via, how: "swipe" | "tap" = "tap", opts: { until?: string; done?: boolean } = {}) => {
    const held = deck.heldId === idOf(item);
    onCommit(item);
    if (!deck.commit(item, via)) {
      flashRefused(item.pendingApproval ? "approval" : "main");
      return;
    }
    const move = ledger.made(idOf(item));
    if (isMove(via) && !opts.done)
      void makeMove(moves, item, via, how, opts.until).then((r) => {
        // Undo already put it back (or the card has moved again since): the tally and the card stay as they are.
        if ((!r.error && !r.ask) || !ledger.stands(idOf(item), move)) return;
        bringBack(item, via, held);
        if (r.error) onNote(r.error);
        else onAsk(item, how);
      });
    const rest = deck.visible.filter((i) => idOf(i) !== idOf(item));
    setSaid(reviewAnnouncement(via, rest[0], rest.length));
    if (!reduced) {
      setLeaving({ item, dir: via === "later" || via === "archive" || via === "deny" ? -1 : 1 });
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
      // Not taken back: the move stands, so the card goes again and the tally counts it again.
      deck.commit(item, via);
      onNote(err);
    });
  };
  return { leaving, undo, refused, said, commit, undoLast, flashRefused };
}

/** A drag never starts on something that takes a finger itself: the box, a control, a code block that scrolls sideways. */
const OWN_GESTURE = "textarea, input, select, button, a, pre, summary, [data-attachments], [data-question]";

/**
 * Pointer Events on the top card (touch and mouse alike). A drag starts only once the finger has
 * moved more sideways than up and past the slop, so the thread inside still scrolls (pan-y hands
 * vertical pans to the browser, which then cancels our pointer), and never from the message box or a
 * control. Owns the drag offset and the velocity samples.
 */
function useSwipe({
  width,
  approval,
  typed,
  sending,
  current,
  onCommit,
  onRefuse,
}: {
  width: number;
  approval: boolean;
  /** The top card's reply box holds text: a swipe springs back (deck.ts swipeDecision). */
  typed: boolean;
  /** The top card's reply is on its way, and takes the card with it: a swipe springs back until it lands. */
  sending: boolean;
  current: AttentionItem | undefined;
  onCommit: (item: AttentionItem, via: Swipe) => void;
  onRefuse: (why: Refusal) => void;
}) {
  const [drag, setDrag] = useState<{ dx: number } | null>(null);
  // Where and how fast the last drag was let go: the spring home, or off, carries that speed.
  const [release, setRelease] = useState<Release | null>(null);
  const start = useRef<{ x: number; y: number; id: number; dragging: boolean; base: number; samples: Sample[] } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if ((e.target as Element).closest(OWN_GESTURE)) return;
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId, dragging: false, base: 0, samples: [{ at: e.clientX, t: e.timeStamp }] };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const s = start.current;
    if (s?.id !== e.pointerId) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (!s.dragging) {
      if (!isHorizontalDrag(dx, dy)) return;
      s.dragging = true;
      // Caught while still springing home: the finger takes it from where it is, not from the middle.
      s.base = onScreenOffset(e.currentTarget, "x");
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* a pointer that already left */
      }
    }
    s.samples.push({ at: e.clientX, t: e.timeStamp });
    if (s.samples.length > 12) s.samples.shift();
    setDrag({ dx: dx + s.base });
  };
  const finish = (e: ReactPointerEvent<HTMLElement>, cancelled: boolean) => {
    const s = start.current;
    if (s?.id !== e.pointerId) return;
    start.current = null;
    if (!s.dragging) return;
    const dx = e.clientX - s.x + s.base;
    // px per ms, as the deck's helpers take it.
    const v = cancelled ? 0 : releaseVelocity(s.samples, e.timeStamp) / 1000;
    const decision = cancelled || !current ? null : swipeDecision(dx, width, v, { approval, typed: typed || sending });
    if (current) setRelease({ id: idOf(current), committed: !!decision, dx: approval ? refusedOffset(dx) : dx, v: approval ? 0 : v });
    if (cancelled || !current) {
      setDrag(null);
      return;
    }
    if (decision) onCommit(current, decision);
    else {
      setDrag(null);
      if ((approval || typed || sending) && Math.abs(dx) > DRAG_SLOP * 2) onRefuse(approval ? "approval" : sending ? "sending" : "typed");
    }
  };
  const handlers: CardHandlers = { onPointerDown, onPointerMove, onPointerUp: (e) => finish(e, false), onPointerCancel: (e) => finish(e, true) };
  return { drag, release, clear: () => setDrag(null), handlers };
}

/** A drag let go: which card, whether it went, where it was (px) and how fast it was going (px per ms). */
interface Release {
  id: string;
  committed: boolean;
  dx: number;
  v: number;
}

/** What the card's conversation can do: reply (text, images), answer the open question, take back a queued message. */
export interface CardActions {
  onSend: (item: AttentionItem, text: string, images: Attachment[]) => void;
  onAnswer: (item: AttentionItem, requestId: string, answers: Record<string, string | string[]>) => void;
  onCancelQueued: (item: AttentionItem, text: string) => void;
  /** Stop the card's conversation's turn, so you can take over; resolves to an error or null. */
  onStop?: (item: AttentionItem) => Promise<string | null>;
  /** The model pill in the card's box, as on the conversation page; absent, the box has none. */
  model?: CardModel;
  /** The suggestions made in the card's chat for other chats (plan 049), over its box; absent, none. */
  suggestions?: Omit<SuggestionsProps, "rt">;
}

/** What the card's model pill needs: the list, the card's model and effort, and switching it. */
export interface CardModel {
  models: ModelEntry[] | null;
  onLoad: () => void;
  modelOf: (item: AttentionItem) => string | null;
  effortOf: (item: AttentionItem) => ReasoningEffort | null;
  onPick?: (item: AttentionItem, selection: ModelSelection) => Promise<void>;
}

/**
 * The phone's Inbox, the review pass: one card at a time from `deck`, with the states for an empty,
 * unloaded or unreachable inbox. `hidden` keeps everything but shows nothing.
 */
export function Inbox({
  items,
  loaded,
  available,
  hidden = false,
  banner,
  chats,
  deck,
  backLabel,
  onClose,
  onOpen,
  onConnection,
  onApprove,
  onShown,
  moves,
  onNote,
  card,
  labelList = null,
}: {
  /** The labels' colours (plan 022), for the top card's chips. */
  labelList?: readonly LabelView[] | null;
  items: AttentionItem[];
  /** The daemon has answered at least once; before that an empty list means nothing. */
  loaded: boolean;
  /** The Mac serves chats; without them there is no inbox to read. */
  available: boolean;
  /** Another tab or a page is on top: keep everything (the pass, the thread's scroll, the draft) but show nothing. */
  hidden?: boolean;
  /** "Mac unreachable · last seen …", or null while the link is fine. In a pass it takes the card's notice line. */
  banner?: ReactNode;
  /** The live threads behind the cards (useAttention's), read through useConversation, and an outside card's hand-off. */
  chats: ChatViews & Partial<HandoffSource> & Partial<OutsideSource>;
  /** The pass, from `useDeck` in the parent. */
  deck: Deck;
  /** Where the top bar's back chevron goes, as a word ("Home"). */
  backLabel: string;
  /** Leave the pass (the navigation is hidden while a card is up). */
  onClose: () => void;
  /** Open the card's desk, full screen. */
  onOpen: (item: AttentionItem) => void;
  /** The pairing and connection details, for the states where the Mac is the problem. */
  onConnection: () => void;
  onApprove: (item: AttentionItem, requestId: string, behavior: "allow" | "deny" | "always") => void;
  /** A card came to the top while the Inbox is on screen (analytics: its dwell clock starts). */
  onShown?: (item: AttentionItem) => void;
  /** Read, Later, Archive, Label and Undo, written out there too; each reports itself for analytics and the ledger. */
  moves: InboxMoves;
  /** A move that did not go, in words ("Not marked read: …"), for the banner. */
  onNote: (text: string) => void;
  card: CardActions;
}) {
  const reduced = useReducedMotion();
  const { visible, current } = deck;
  const { deckRef, width } = useDeckWidth(!!current);

  const running = items.filter((i) => i.status === "running").length;
  const approval = !!current?.pendingApproval;
  const currentId = current ? idOf(current) : null;
  // The card whose reply box holds text: its swipes spring back until it is sent or the card is moved by a button.
  const [typedId, setTypedId] = useState<string | null>(null);
  const typed = !!currentId && typedId === currentId;
  // The card whose reply is on its way: the reply reads it and takes it off, so its buttons and swipes wait until then.
  const [sendingId, setSendingId] = useState<string | null>(null);
  const sending = !!currentId && sendingId === currentId;
  // A Later that asks when first, and the email card whose labels are being picked: each in its sheet.
  const [asking, setAsking] = useState<{ item: AttentionItem; how: "swipe" | "tap" } | null>(null);
  const [labelling, setLabelling] = useState<AttentionItem | null>(null);

  const { leaving, undo, refused, said, commit, undoLast, flashRefused } = usePass({
    deck,
    reduced,
    moves,
    onNote,
    onAsk: (item, how) => setAsking({ item, how }),
    onCommit: (item) => {
      swipe.clear();
      if (idOf(item) === typedId) setTypedId(null);
    },
  });
  /** Later, which asks first when it is the second in a row (R7): the card stays and the sheet opens. */
  const later = (item: AttentionItem, how: "swipe" | "tap") => {
    if (!item.pendingApproval && moves.laterAsks(item)) {
      swipe.clear();
      setAsking({ item, how });
    } else commit(item, "later", how);
  };
  const swipe = useSwipe({
    width,
    approval,
    typed,
    sending,
    current,
    onCommit: (item, via) => (via === "later" ? later(item, "swipe") : commit(item, via, "swipe")),
    onRefuse: flashRefused,
  });
  const shown = useEffectEvent(() => {
    if (current && !hidden) onShown?.(current);
  });
  useEffect(() => shown(), [currentId, hidden]);

  // What needs you (the badge's count), and every chat still in the Inbox: a chat stays until it is archived, so there is no pass to count down.
  const needYou = catchUpQueue(items).length;

  // The last card going (or a new pass starting) takes the pressed button with it; focus would fall to the
  // page body, so it moves to the pass's heading instead, where the next thing to read or press starts.
  const rootRef = useRef<HTMLDivElement>(null);
  const hasCard = !!current;
  const settled = useRef(false);
  useEffect(() => {
    const a = document.activeElement;
    const first = !settled.current;
    settled.current = true;
    if (first || hidden || (a && a !== document.body && a.isConnected)) return; // not on first load (session.ts leaves that alone too)
    rootRef.current?.querySelector<HTMLElement>("[data-phone-heading]")?.focus({ preventScroll: true });
  }, [hasCard, hidden]);

  return (
    <div ref={rootRef} className="loki-phone-inbox loki-phone-above-nav" data-away={hidden || undefined} aria-hidden={hidden || undefined}>
      <TopBar
        left={
          current ? (
            <button type="button" className="loki-phone-icon-btn" aria-label={`Back to ${backLabel}`} onClick={onClose}>
              <Icon name="back" size={22} />
            </button>
          ) : undefined
        }
        title={current ? (needYou ? `${needYou} need you` : `${visible.length} ${visible.length === 1 ? "chat" : "chats"}`) : "Inbox"}
        right={undo ? <UndoButton key={idOf(undo.item)} via={undo.via} onUndo={undoLast} /> : undefined}
      />
      <div className="loki-phone-sr-only" role="status" aria-live="polite">
        {said}
      </div>

      {!current ? (
        <EmptyDeck
          available={available}
          loaded={loaded}
          banner={banner}
          running={running}
          passedOver={catchUpQueue(items).length}
          onAgain={deck.again}
          resting={deck.resting ? 0 : restingCount(items)}
          onResting={deck.restingToo}
          pass={deck.pass}
          backLabel={backLabel}
          onClose={onClose}
          onConnection={onConnection}
        />
      ) : (
        <>
          <div ref={deckRef} className="loki-phone-deck">
            <Reveal dx={swipe.drag?.dx ?? 0} width={width} approval={approval || typed || sending} />
            <Stack
              onTyped={(item, has) => setTypedId((t) => (has ? idOf(item) : t === idOf(item) ? null : t))}
              onSending={(item, on) => setSendingId((t) => (on ? idOf(item) : t === idOf(item) ? null : t))}
              // A button that slipped through while it sent has taken the card off already: count it once.
              onReplied={(item) => {
                if (!deck.dismissed(item)) commit(item, "seen", "tap", { done: true });
              }}
              visible={visible}
              leaving={leaving}
              drag={swipe.drag}
              release={swipe.release}
              width={width}
              approval={approval}
              refused={refused}
              reduced={reduced}
              chats={chats}
              handlers={swipe.handlers}
              deck={deck}
              banner={banner}
              card={card}
              onOpen={onOpen}
              labelList={labelList}
              items={items}
            />
          </div>
          <Decisions
            item={current}
            sending={sending}
            onRead={() => commit(current, "seen")}
            onLater={() => later(current, "tap")}
            onArchive={() => commit(current, "archive")}
            onLabel={current.outside?.provider === "gmail" ? () => setLabelling(current) : undefined}
            onApprove={(behavior) => {
              if (!current.pendingApproval) return;
              onApprove(current, current.pendingApproval.requestId, behavior);
              commit(current, behavior !== "deny" ? "approve" : "deny");
            }}
          />
        </>
      )}
      {asking && (
        <ReturnTimeSheet
          title={asking.item.title ?? asking.item.id}
          onClose={() => setAsking(null)}
          onPick={(until) => {
            commit(asking.item, "later", asking.how, { until });
            setAsking(null);
          }}
        />
      )}
      {labelling && (
        <MailLabelsSheet load={() => moves.labelsOf(labelling)} onAdd={(ids) => moves.label(labelling, ids, "tap")} onClose={() => setLabelling(null)} />
      )}
    </div>
  );
}

/**
 * No card up: still reading (a card's shape), or why (loki not running, the Mac unreachable, every chat moved past), what
 * this visit did, and what to do next.
 */
function EmptyDeck({
  available,
  loaded,
  banner,
  running,
  passedOver,
  onAgain,
  resting,
  onResting,
  pass,
  backLabel,
  onClose,
  onConnection,
}: {
  available: boolean;
  loaded: boolean;
  banner?: ReactNode;
  running: number;
  /** Chats this visit went past; the badge still counts the ones that need you. */ passedOver: number;
  onAgain: () => void;
  /** Cards Read or Later has rested, not due back yet (core/attention/rest.ts). */
  resting: number;
  onResting: () => void;
  pass: PassSummary;
  backLabel: string;
  onClose: () => void;
  onConnection: () => void;
}) {
  const summary = summaryLine(pass);
  const macProblem = !available || !!banner;
  if (!loaded && !macProblem)
    return (
      <div className="loki-phone-scroll loki-phone-scroll--flush">
        <SkeletonCard label="Reading the inbox…" />
      </div>
    );
  // Passed over is not caught up: the badge and Home still count those cards, so the words must too.
  const again = loaded && !macProblem && passedOver > 0;
  const title = !available
    ? "loki is not running on the Mac"
    : banner
      ? "The Mac is out of reach"
      : again
        ? "You've been through every chat"
        : "You're caught up";
  const line = !available
    ? "Open loki on the Mac."
    : banner
      ? "Cards come back when it reconnects; nothing in the Inbox is lost."
      : again
        ? `${passedOver === 1 ? "1 chat still needs" : `${passedOver} chats still need`} you. Every chat stays until you archive it.`
        : resting > 0
          ? resting === 1
            ? "1 chat rests until it's due or something new comes."
            : `${resting} chats rest until they're due or something new comes.`
          : running > 0
            ? `${running} still running. They land here when they finish.`
            : "Nothing is waiting on you.";
  // The pass came to its end (or there was nothing to pass): the check springs in and what the pass did rises after it.
  const done = loaded && !macProblem;
  return (
    <>
      {banner}
      <div className="loki-phone-scroll loki-phone-scroll--flush">
        <div className="loki-phone-empty" role="status" data-done={done || undefined}>
          <Icon name={macProblem ? "laptop" : "check"} size={32} className="loki-phone-empty-mark" />
          <p className="loki-phone-headline">{title}</p>
          <p>{line}</p>
          {summary && <p className="loki-phone-meta">This visit: {summary}</p>}
          {macProblem ? (
            <Button size="touch" tone="paper" onClick={onConnection}>
              Connection details
            </Button>
          ) : (
            <div className="loki-phone-empty-actions">
              {again && (
                <Button size="touch" tone="paper" onClick={onAgain}>
                  Go through again
                </Button>
              )}
              {!again && resting > 0 && (
                <Button size="touch" tone="paper" onClick={onResting}>
                  Go through them
                </Button>
              )}
              <Button size="touch" tone="paper" onClick={onClose}>
                Back to {backLabel}
              </Button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * Under the top card while it is dragged: Read on the left, uncovered by a right drag, and Later on the right,
 * uncovered by a left one. A card that refuses swipes (an approval, a reply not yet sent) reveals nothing.
 */
function Reveal({ dx, width, approval }: { dx: number; width: number; approval: boolean }) {
  const shown = approval ? 0 : revealOpacity(dx, width);
  const read = dx > 0 ? shown : 0;
  const later = dx < 0 ? shown : 0;

  // Past the commit distance the word under the card pops (phone.css): letting go now does it.
  const ready = !approval && armed(dx, width);
  return (
    <div aria-hidden className="loki-phone-reveal">
      <span className="loki-phone-reveal-read" data-armed={(ready && dx > 0) || undefined} style={{ opacity: read, transform: `scale(${0.9 + read * 0.1})` }}>
        <Icon name="check" size={20} /> Read
      </span>
      <span
        className="loki-phone-reveal-later"
        data-armed={(ready && dx < 0) || undefined}
        style={{ opacity: later, transform: `scale(${0.9 + later * 0.1})` }}
      >
        Later <Icon name="clock" size={20} />
      </span>
    </div>
  );
}

interface CardHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
}

/** One keyed list, one component: a card keeps its DOM node as it goes shell → top → leaving, so its transform transitions between poses. */
function Stack({
  visible,
  leaving,
  drag,
  release,
  width,
  approval,
  refused,
  reduced,
  chats,
  handlers,
  deck,
  banner,
  card,
  onOpen,
  labelList,
  items,
  onTyped,
  onSending,
  onReplied,
}: {
  /** The top outside card's reply box went from empty to holding text, or back. */
  onTyped: (item: AttentionItem, has: boolean) => void;
  /** The top outside card's reply started on its way, or landed (sent or not). */
  onSending: (item: AttentionItem, on: boolean) => void;
  /** A reply from the top outside card was sent and the card marked read with it. */
  onReplied: (item: AttentionItem) => void;
  labelList: readonly LabelView[] | null;
  /** Every card in the Inbox, where a follow-up card finds the title of the chat its thread went to (R19). */
  items: AttentionItem[];
  visible: AttentionItem[];
  leaving: Leaving | null;
  drag: { dx: number } | null;
  release: Release | null;
  width: number;
  approval: boolean;
  refused: boolean;
  reduced: boolean;
  chats: ChatViews & Partial<HandoffSource> & Partial<OutsideSource>;
  handlers: CardHandlers;
  deck: Deck;
  banner?: ReactNode;
  card: CardActions;
  onOpen: (item: AttentionItem) => void;
}) {
  const dx = drag?.dx ?? 0;
  // The top card's suggestions open from its mark, for that card only (a later card never opens on the bump).
  const [suggestTick, setSuggestTick] = useState<ChatTick>(null);
  // Every move is a spring (kit/spring.ts): the cards behind rise on the smooth one; a card let go springs
  // home on the snappy one, or flies off on the smooth one, either way carrying the finger's speed.
  const rise = spring("smooth");
  const move = reduced ? "none" : `transform ${rise.ms}ms ${rise.easing}`;
  const flyTo = leaving ? leaving.dir * (width + FLY_PAST) : 0;
  // Only the card that was let go carries the speed: a card sent off by a button, or rising into the top place, starts still.
  const flung = leaving && release?.committed && release.id === idOf(leaving.item) ? release : null;
  const fly = spring("smooth", flung ? flingVelocity(flung.dx, flyTo, flung.v) : 0);
  const homeFrom = (item: AttentionItem) =>
    release && !release.committed && release.id === idOf(item) ? spring("snappy", flingVelocity(release.dx, 0, release.v)) : rise;
  return cardsToDraw(visible, leaving?.item ?? null).map(({ item, role, index }) => {
    if (role === "leaving")
      return (
        <Card
          key={idOf(item)}
          item={item}
          role={role}
          style={{
            zIndex: 3,
            transform: `translateX(${flyTo}px) rotate(${(leaving?.dir ?? 0) * 12}deg)`,
            opacity: 0,
            transition: reduced ? "none" : `transform ${fly.ms}ms ${fly.easing}, opacity ${fly.ms}ms ease-in`,
          }}
        >
          {item.outside ? <OutsideBody item={item} /> : <ReadOnlyThread item={item} chats={chats} />}
        </Card>
      );
    if (role === "top") {
      const offset = approval ? refusedOffset(dx) : dx;
      return (
        <Card
          key={idOf(item)}
          item={item}
          role={role}
          refused={refused}
          labelList={labelList}
          suggestions={card.suggestions ? waitingCount(card.suggestions.source, item.runtime) : 0}
          onSuggestions={() => setSuggestTick((t) => bumpTick(t, idOf(item)))}
          style={{
            zIndex: 2,
            transform: drag ? `translateX(${offset}px) rotate(${rotationFor(offset, width)}deg)` : "none",
            transition: drag || reduced ? "none" : `transform ${homeFrom(item).ms}ms ${homeFrom(item).easing}`,
          }}
          handlers={handlers}
          onOpen={
            // An outside card (plan 067) has no chat to open until it is handed off.
            item.outside
              ? undefined
              : () => {
                  openFromCard(); // the conversation grows out of the card (transitions.ts)
                  onOpen(item);
                }
          }
        >
          {item.outside ? (
            <OutsideBody
              item={item}
              banner={banner}
              went={wentTo(item.outside, items)}
              handoff={chats.handoffPropose && chats.handoff ? { handoffPropose: chats.handoffPropose, handoff: chats.handoff } : null}
              outside={chats.readOutside && chats.replyOutside ? { readOutside: chats.readOutside, replyOutside: chats.replyOutside } : null}
              onTyped={(has) => onTyped(item, has)}
              onSending={(on) => onSending(item, on)}
              onReplied={() => onReplied(item)}
            />
          ) : (
            <LiveCardConversation
              item={item}
              chats={chats}
              banner={banner}
              card={card}
              onHold={() => deck.hold(item)}
              suggestionsTick={tickOf(suggestTick, idOf(item))}
            />
          )}
        </Card>
      );
    }
    const pose = stackPose(index);
    return (
      <Card
        key={idOf(item)}
        item={item}
        role={role}
        veil={1 - pose.opacity}
        style={{ zIndex: 1 - index, transform: `translateY(${pose.offsetY}px) scale(${pose.scale})`, transition: move }}
      />
    );
  });
}

/**
 * The card: who it is with (a button that opens the desk), then the body. Only the top card is live;
 * the ones behind are its frame and head under a veil, and the one flying off is inert.
 */
export function Card({
  item,
  role,
  refused = false,
  veil = 0,
  style,
  handlers,
  onOpen,
  labelList,
  suggestions = 0,
  onSuggestions,
  children,
}: {
  item: AttentionItem;
  role: Role;
  /** How many suggestions made in this chat wait (plan 052), and the press on its mark that opens them. */
  suggestions?: number;
  onSuggestions?: () => void;
  /** Given to the top card only: its chat's labels show under its title. */
  labelList?: readonly LabelView[] | null;
  refused?: boolean;
  /** 0..1: how much of the veil sits over a card behind the top one. */ veil?: number;
  style: CSSProperties;
  handlers?: CardHandlers;
  onOpen?: () => void;
  children?: ReactNode;
}) {
  const top = role === "top";
  // An outside card names who wrote it, and its account and agent where a chat names its folder (plan 067, R10); a mail
  // has its subject for a title, a Slack message only its sender (plan 068).
  const title = item.outside ? (item.outside.provider === "gmail" ? outsideTitle(item.outside) : outsideWho(item.outside)) : (item.title ?? item.id);
  const who = item.outside ? senderName(item.outside.sender) : (item.agent_name ?? "agent");
  return (
    <article
      className="loki-phone-card"
      data-role={role}
      data-refused={refused || undefined}
      aria-label={top ? `${title}, with ${item.agent_name ?? "the agent"}` : undefined}
      aria-hidden={!top || undefined}
      inert={!top}
      {...(top ? handlers : {})}
      style={style}
    >
      <header className="loki-phone-card-head">
        <button
          type="button"
          className="loki-phone-card-who"
          onClick={onOpen}
          aria-label={item.outside ? `${title}, from ${who}` : `Open ${title} with ${item.agent_name ?? "the agent"}`}
          tabIndex={top ? undefined : -1}
        >
          <Avatar name={item.outside ? who : item.agent_name} src={item.outside ? null : avatarUrl(item.agent_id)} size={28} />
          <span className="loki-phone-ellipsis">{who}</span>
          {!item.outside && <Icon name="chevron-down" size={16} />}
        </button>
        <span className="loki-phone-card-desk">
          <span className="loki-phone-ellipsis">{title}</span>
          <span aria-hidden>·</span>
          <span className="loki-phone-card-when">{waitingSince(item)}</span>
          {item.outside?.provider === "gmail" && (
            <>
              <span aria-hidden>·</span>
              <span className="loki-phone-ellipsis">{outsideWho(item.outside)}</span>
            </>
          )}
          {item.has_draft && (
            <>
              <span aria-hidden>·</span>
              <span className="loki-phone-card-draft">Draft</span>
            </>
          )}
          {suggestions > 0 && (
            <>
              <span aria-hidden>·</span>
              <button type="button" className="loki-phone-card-suggestions" onClick={onSuggestions} aria-haspopup="dialog" tabIndex={top ? undefined : -1}>
                {sentence(chipText(suggestions, false))}
              </button>
            </>
          )}
        </span>
        {labelList !== undefined && <LabelChips labels={item.labels} list={labelList} max={3} />}
      </header>
      {children && <div className="loki-phone-card-body loki-phone-thread">{children}</div>}
      {/* Cards behind the top one are dimmed by an opaque veil, not opacity, so the stack does not show through itself. */}
      {veil > 0 && <div aria-hidden className="loki-phone-card-veil" style={{ opacity: veil }} />}
    </article>
  );
}

/** The top card's conversation, redrawn as its thread moves (useConversation). */
function LiveCardConversation({ chats, ...card }: { chats: ChatViews } & Omit<Parameters<typeof CardConversation>[0], "view">) {
  const view = useConversation(chats, card.item.agent_id, card.item.id);
  return <CardConversation {...card} view={view} />;
}

/**
 * The top card's conversation: the shared chat surface with the phone's message layout, the unread line,
 * the notice (or the link state while the Mac is out of reach), and a message box whose draft lives in
 * session.ts under this conversation's key — the same draft the desk page shows. A message or an answer
 * from here holds the card on top until you decide it. Approve and deny are the buttons under the card.
 */
export function CardConversation({
  item,
  view,
  banner,
  card,
  onHold,
  suggestionsTick = 0,
}: {
  item: AttentionItem;
  view: CardView;
  /** Bumped by the card's mark: opens its suggestions' sheet. */
  suggestionsTick?: number;
  banner?: ReactNode;
  card: CardActions;
  onHold: () => void;
}) {
  const [draft, setDraft] = useDraft(draftKey(item.agent_id, item.id));
  const agentName = item.agent_name ?? "the agent";
  const layout = useThreadLayout({ agentId: item.agent_id, conversationId: item.id, agentName: item.agent_name }, view.rows, item, item.viewedAt);
  const question = view.question ?? null;
  const approval = view.pending ?? item.pendingApproval;
  const said = cardNotice(item, view.status);
  const notice = banner ?? (said && <ThreadNotice text={said} />);
  const model = card.model;
  const onPick = model?.onPick;
  const onStop = card.onStop;
  const message = useMessageActions({ user: "You", assistant: item.agent_name ?? "Agent" });
  return message.wrap(
    <OpenChat.Provider value={openConversation}>
      {message.sheet}
      <Conversation
        touch
        dim={false}
        view={{
          rows: view.rows,
          status: view.status,
          error: item.status === "failed" ? (item.error ?? view.error ?? null) : (view.error ?? null),
          approval,
          question,
          model: model?.modelOf(item) ?? null,
          reasoningEffort: model?.effortOf(item) ?? null,
          older: view.older ?? null,
          loadFailed: view.loadFailed ?? null,
          loadStep: view.loadStep,
        }}
        models={model?.models ?? null}
        actions={{
          onLoadModels: model?.onLoad,
          onPickModel: onPick ? (selection) => onPick(item, selection) : undefined,
          onSend: (text, images = []) => card.onSend(item, text, images),
          onAnswer: question
            ? (answers) => {
                card.onAnswer(item, question.requestId, answers);
                onHold();
              }
            : undefined,
          onCancelQueued: (text) => card.onCancelQueued(item, text),
          onStop: onStop ? () => onStop(item) : undefined,
        }}
        agentName={agentName}
        layout={layout}
        notice={notice || null}
        placeholder={replyPlaceholder(!!question, !!approval, agentName)}
        draft={{ value: draft, onChange: setDraft }}
        onSent={onHold}
        suggestions={card.suggestions ? { ...card.suggestions, rt: item.runtime } : null}
        suggestionsTick={suggestionsTick}
      />
    </OpenChat.Provider>,
  );
}

/**
 * An outside card's body (plan 067, U3, U8; plan 068): the account's state when it stopped working, the chat the thread
 * went to before, the whole thread, the box for the person's own reply, and Hand off, which opens the chats to give the
 * thread to. Send sends the reply and marks the thread read (plan 070, R11), so the card goes as Read would. While the
 * box holds text the card tells the deck (`onTyped`), whose swipes then spring back.
 */
function OutsideBody({
  item,
  banner,
  went = null,
  handoff = null,
  outside = null,
  onTyped,
  onSending,
  onReplied,
}: {
  item: AttentionItem;
  banner?: ReactNode;
  went?: string | null;
  /** The hand-off, on the top card only. */
  handoff?: HandoffSource | null;
  /** Reading the thread and replying, on the top card only. */
  outside?: OutsideSource | null;
  onTyped?: (has: boolean) => void;
  /** The reply is on its way (true) or has landed (false), so the deck holds its moves meanwhile. */
  onSending?: (on: boolean) => void;
  onReplied?: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const thread = useOutsideThread(item, outside);
  const facts = item.outside;
  if (!facts) return null;
  return (
    <div style={{ padding: "var(--phone-space-3) var(--phone-gutter)", display: "flex", flexDirection: "column", gap: "var(--phone-space-3)" }}>
      {banner}
      {facts.disconnected && <ThreadNotice text={sentence(disconnectedText(facts.disconnected, facts.provider))} />}
      {went && <span className="loki-phone-meta">{sentence(went)}</span>}
      <OutsideThread facts={facts} state={thread} touch />
      {outside && (
        // The card takes a drag for a swipe; a drag or a tap inside the reply is the reply's.
        // Its text is read off the input as it bubbles, so the shared box needs no new prop.
        <div
          onPointerDown={stopPointer}
          onPointerMove={stopPointer}
          onPointerUp={stopPointer}
          onInput={(e) => e.target instanceof HTMLTextAreaElement && onTyped?.(!!e.target.value.trim())}
        >
          <OutsideReply
            facts={facts}
            touch
            onSend={async (text) => {
              onSending?.(true);
              try {
                const r = await outside.replyOutside(item, text, "read");
                // A sent reply clears the box, which fires no input: the swipes come back here.
                if (r.sent) onTyped?.(false);
                if (r.sent && !r.error) onReplied?.();
                return r;
              } finally {
                onSending?.(false);
              }
            }}
          />
        </div>
      )}
      {handoff &&
        (picking ? (
          // The card leaves the Inbox once the thread went, so there is nothing to do on done but close.
          <HandoffPicker item={item} source={handoff} touch onCancel={() => setPicking(false)} onDone={() => setPicking(false)} />
        ) : (
          <Button
            size="touch"
            tone="positive"
            disabled={!!facts.disconnected}
            onClick={() => setPicking(true)}
            aria-label={`Hand off to ${facts.owner_name ?? "its agent"}`}
          >
            Hand off
          </Button>
        ))}
    </div>
  );
}

/** Keeps a pointer inside the reply box from moving the card. */
const stopPointer = (e: { stopPropagation: () => void }) => e.stopPropagation();

/** The card flying off: its thread as it was, nothing to type into. */
function ReadOnlyThread({ item, chats }: { item: AttentionItem; chats: ChatViews }) {
  const view = useConversation(chats, item.agent_id, item.id);
  return (
    <Thread
      rows={view.rows}
      status={view.status}
      agentName={item.agent_name}
      dim={false}
      older={view.older ?? null}
      loadFailed={view.loadFailed ?? null}
      loadStep={view.loadStep}
    />
  );
}

/**
 * The big buttons under the card, laid out as the swipes go: Later on the left, then Label (an email card only,
 * `onLabel`) and Archive (a button only), and Read on the right, under the thumb; or — for an approval, which leaves
 * only by its decision — Deny and Approve. The card's conversation opens from its head.
 */
export function Decisions({
  item,
  sending = false,
  onRead,
  onLater,
  onArchive,
  onLabel,
  onApprove,
}: {
  item: AttentionItem;
  /** The card's reply is on its way and moves the card itself: Later, Archive and Read wait until it lands. */
  sending?: boolean;
  onRead: () => void;
  onLater: () => void;
  onArchive: () => void;
  onLabel?: () => void;
  onApprove: (behavior: "allow" | "deny" | "always") => void;
}) {
  const approval = item.pendingApproval;
  if (approval)
    return (
      <div className="loki-phone-decide">
        <button
          type="button"
          className="loki-phone-decide-btn loki-phone-decide-btn--deny"
          onClick={() => onApprove("deny")}
          aria-label={`Deny ${approval.toolName}`}
        >
          Deny
        </button>
        <button
          type="button"
          className="loki-phone-decide-btn loki-phone-decide-btn--affirm"
          onClick={() => onApprove("allow")}
          aria-label={`Approve ${approval.toolName}`}
        >
          Approve
        </button>
        <button type="button" className="loki-phone-decide-always" onClick={() => onApprove("always")} aria-label={`Always allow ${approval.toolName}`}>
          Always allow {approval.toolName}
        </button>
      </div>
    );
  return (
    <div className="loki-phone-decide loki-phone-decide--moves">
      <button type="button" className="loki-phone-decide-btn" onClick={onLater} disabled={sending}>
        Later
      </button>
      {onLabel && (
        <button type="button" className="loki-phone-decide-btn" onClick={onLabel} aria-haspopup="dialog">
          Label
        </button>
      )}
      <button type="button" className="loki-phone-decide-btn" onClick={onArchive} disabled={sending}>
        Archive
      </button>
      <button type="button" className="loki-phone-decide-btn loki-phone-decide-btn--affirm" onClick={onRead} disabled={sending}>
        Read
      </button>
    </div>
  );
}

/** `prefers-reduced-motion: reduce`, live. */
function useReducedMotion(): boolean {
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
