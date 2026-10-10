import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useInlineWidgets } from "../chat/useInlineWidgets";
import { scopeFor } from "../../../core/desk-core.ts";
import type { AttentionItem, PendingApproval, PendingQuestion } from "../../../core/attention/model.ts";
import type { Attachment } from "../../../core/attention/content.ts";
import { catchUpQueue, idOf } from "../../../core/attention/queue.ts";
import { formatInput } from "../../../core/attention/format.ts";
import type { TranscriptRow } from "../chat/Transcript";
import { Conversation, Thread } from "../chat/Conversation";
import type { ModelEntry, ModelSelection, ReasoningEffort } from "../chat/ModelPicker";
import { avatarUrl } from "../desk/env";
import { Button } from "../components";
import { waitingSince } from "./model";
import { Icon } from "./icons";
import { Avatar, SkeletonCard } from "./rows";
import { useMessageActions } from "./MessageActions";
import { draftKey, useDraft } from "./session";
import { TopBar } from "./ui";
import { openFromCard } from "./transitions";
import { spring } from "../kit/spring";
import { useLeave } from "../kit/leave";
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
  dayLabel,
  deckQueue,
  flingVelocity,
  holdCard,
  isHorizontalDrag,
  reconcileDeck,
  refusedOffset,
  revealOpacity,
  reviewAnnouncement,
  rotationFor,
  stackPose,
  summaryLine,
  swipeDecision,
  undoCard,
  unreadBoundary,
  velocityOf,
  type DeckState,
  type PassSummary,
  type Role,
  type Swipe,
  type Via,
} from "./deck";

/**
 * The inbox as a review pass, the way Slack's Catch Up works on a phone: one card at a time, the next
 * one or two peeking from behind, "N Left" on top. The card is the conversation itself — who it is
 * with, the thread with the unread line, what the agent waits on, and a working message box — so a card
 * can be read and answered without leaving the Inbox. Under it, Open chat and Next (read, move on: the chat
 * stays for your next visit); a right swipe is Next. Archiving (done) is in the chat's actions sheet.
 * Approvals refuse both, and the two buttons become Deny and Approve. Undo sits in the top bar for six
 * seconds after Archive or Next. The pure parts (when a drag
 * commits, the lean, the pass itself, what the card says) are in deck.ts.
 */

/** The two or three lines a card would show under its title without a thread (kept for callers). */
export function preview(item: AttentionItem): string {
  if (item.pendingApproval) return `run ${item.pendingApproval.toolName}\n${formatInput(item.pendingApproval.input)}`;
  if (item.pendingQuestion) return item.pendingQuestion.questions.map((q) => q.question).join("\n");
  if (item.status === "failed" && item.error) return item.error;
  return item.lastAssistantText ?? "";
}

/** What the deck needs of a conversation to draw it inside a card (useAttention's `conversation`). */
export interface CardView {
  rows: TranscriptRow[] | undefined;
  status: "idle" | "thinking" | "streaming";
  pending?: PendingApproval | null;
  question?: PendingQuestion | null;
  error?: string | null;
  older?: (() => void) | null;
}

/**
 * A pass, held by the parent (Phone.tsx) beside the transcripts it fetches for the top card, so it
 * survives the Inbox being out of sight: the cards in order, the one on top, the tally, and the card
 * held after a reply. `commit` is false when the card refuses that way off (Archive on an approval, or on a main chat).
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
  /** A fresh visit: the cards moved past in this one come back. */
  again: () => void;
}

export function useDeck(items: AttentionItem[]): Deck {
  const [state, setState] = useState<DeckState>(EMPTY_DECK);
  const visible = useMemo(() => deckQueue(items, state), [items, state]);
  const current: AttentionItem | undefined = visible[0];
  // Pin whatever is on top, drop dismissals the live list has outgrown (the same state when nothing moved).
  useEffect(() => {
    setState((s) => reconcileDeck(s, items));
  }, [items, state]);
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
    again: () => setState(EMPTY_DECK),
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

type Undo = { item: AttentionItem; via: Swipe; held: boolean };
/** The card on its way off, and which way it goes. */
type Leaving = { item: AttentionItem; dir: 1 | -1 };

/** Undo in the top bar: it springs in (phone.css) and, when its seconds run out or it is used, shrinks away. */
function UndoButton({ via, onUndo }: { via: Swipe; onUndo: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useLeave(ref, UNDO_LEAVE, 180);
  return (
    <button ref={ref} type="button" className="loki-phone-undo" onClick={onUndo} aria-label={via === "seen" ? "Undo Next" : "Undo Archive"}>
      Undo
    </button>
  );
}
const UNDO_LEAVE: Keyframe[] = [{ opacity: 1 }, { opacity: 0, transform: "scale(0.8)" }];

/**
 * What a pass does on screen as cards go: the card flying off (on the smooth spring, unless motion is reduced),
 * the Undo button's card (for UNDO_MS after Archive or Next), the flash when a card refuses that way off,
 * and the sentence a screen reader hears. `commit` takes the card off and tells the parent; `undoLast`
 * puts the last one back.
 */
function usePass({ deck, reduced, onSeen, onArchive, onUndo, onCommit }: { deck: Deck; reduced: boolean; onSeen: (item: AttentionItem, how: "swipe" | "tap") => void; onArchive: (item: AttentionItem) => void; onUndo: (item: AttentionItem, via: Swipe) => void; onCommit: () => void }) {
  const [leaving, setLeaving] = useState<Leaving | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [refused, setRefused] = useState(false);
  const [said, setSaid] = useState("");
  const undoTimer = useTimer();
  const leaveTimer = useTimer();
  const refuseTimer = useTimer();

  const flashRefused = (item?: AttentionItem) => {
    setRefused(true);
    setSaid(item && !item.pendingApproval ? "A main chat cannot be archived." : "This one needs Approve or Deny.");
    refuseTimer.set(() => setRefused(false), 420);
  };
  const commit = (item: AttentionItem, via: Via, how: "swipe" | "tap" = "tap") => {
    const held = deck.heldId === idOf(item);
    if (!deck.commit(item, via)) {
      onCommit();
      flashRefused(item);
      return;
    }
    onCommit();
    if (via === "seen") onSeen(item, how);
    else if (via === "archive") onArchive(item);
    const rest = deck.visible.filter((i) => idOf(i) !== idOf(item));
    setSaid(reviewAnnouncement(via, rest[0], rest.length));
    if (!reduced) {
      setLeaving({ item, dir: via === "archive" || via === "deny" ? -1 : 1 });
      leaveTimer.set(() => setLeaving((l) => (l && idOf(l.item) === idOf(item) ? null : l)), spring("smooth").ms + 30);
    }
    undoTimer.clear();
    if (via === "seen" || via === "archive") {
      setUndo({ item, via, held });
      undoTimer.set(() => setUndo(null), UNDO_MS);
    } else setUndo(null);
  };
  const undoLast = () => {
    if (!undo) return;
    undoTimer.clear();
    deck.undo(undo.item, undo.via, undo.held);
    setLeaving(null);
    onUndo(undo.item, undo.via);
    setSaid(`Undone. ${undo.item.title ?? undo.item.id} is back.`);
    setUndo(null);
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
function useSwipe({ width, approval, current, onCommit, onRefuse }: { width: number; approval: boolean; current: AttentionItem | undefined; onCommit: (item: AttentionItem, via: Swipe) => void; onRefuse: () => void }) {
  const [drag, setDrag] = useState<{ dx: number } | null>(null);
  // Where and how fast the last drag was let go: the spring home, or off, carries that speed.
  const [release, setRelease] = useState<Release | null>(null);
  const start = useRef<{ x: number; y: number; id: number; dragging: boolean; base: number; samples: { x: number; t: number }[] } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if ((e.target as Element).closest(OWN_GESTURE)) return;
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId, dragging: false, base: 0, samples: [{ x: e.clientX, t: e.timeStamp }] };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const s = start.current;
    if (!s || s.id !== e.pointerId) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (!s.dragging) {
      if (!isHorizontalDrag(dx, dy)) return;
      s.dragging = true;
      // Caught while still springing home: the finger takes it from where it is, not from the middle.
      s.base = currentOffset(e.currentTarget);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* a pointer that already left */
      }
    }
    s.samples.push({ x: e.clientX, t: e.timeStamp });
    if (s.samples.length > 12) s.samples.shift();
    setDrag({ dx: dx + s.base });
  };
  const finish = (e: ReactPointerEvent<HTMLElement>, cancelled: boolean) => {
    const s = start.current;
    if (!s || s.id !== e.pointerId) return;
    start.current = null;
    if (!s.dragging) return;
    const dx = e.clientX - s.x + s.base;
    const v = cancelled ? 0 : velocityOf(s.samples);
    const decision = cancelled || !current ? null : swipeDecision(dx, width, v, { approval });
    if (current) setRelease({ id: idOf(current), committed: !!decision, dx: approval ? refusedOffset(dx) : dx, v: approval ? 0 : v });
    if (cancelled || !current) {
      setDrag(null);
      return;
    }
    if (decision) onCommit(current, decision);
    else {
      setDrag(null);
      if (approval && Math.abs(dx) > DRAG_SLOP * 2) onRefuse();
    }
  };
  const handlers: CardHandlers = { onPointerDown, onPointerMove, onPointerUp: (e) => finish(e, false), onPointerCancel: (e) => finish(e, true) };
  return { drag, release, clear: () => setDrag(null), handlers };
}

/** A drag let go: which card, whether it went, where it was (px) and how fast it was going (px per ms). */
type Release = { id: string; committed: boolean; dx: number; v: number };

/** The card's translateX as it is drawn right now, mid-spring included. */
function currentOffset(el: Element): number {
  const t = getComputedStyle(el).transform;
  if (!t || t === "none" || typeof DOMMatrixReadOnly === "undefined") return 0;
  return new DOMMatrixReadOnly(t).m41;
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
}

/** What the card's model pill needs: the list, the card's model and effort, and switching it. */
export interface CardModel {
  models: ModelEntry[] | null;
  onLoad: () => void;
  modelOf: (item: AttentionItem) => string | null;
  effortOf: (item: AttentionItem) => ReasoningEffort | null;
  onPick?: (item: AttentionItem, selection: ModelSelection) => Promise<void>;
}

export function Inbox({
  items,
  loaded,
  available,
  hidden = false,
  banner,
  conversation,
  deck,
  backLabel,
  onClose,
  onOpen,
  onConnection,
  onApprove,
  onSeen,
  onShown,
  onArchive,
  onUndo,
  card,
}: {
  items: AttentionItem[];
  /** The daemon has answered at least once; before that an empty list means nothing. */
  loaded: boolean;
  /** The Mac serves chats; without them there is no inbox to read. */
  available: boolean;
  /** Another tab or a page is on top: keep everything (the pass, the thread's scroll, the draft) but show nothing. */
  hidden?: boolean;
  /** "Mac unreachable · last seen …", or null while the link is fine. In a pass it takes the card's notice line. */
  banner?: ReactNode;
  /** The live thread behind a card; `rows` is undefined until loaded. */
  conversation: (agentId: string, conversationId: string) => CardView;
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
  onApprove: (item: AttentionItem, requestId: string, behavior: "allow" | "deny") => void;
  /** Next: `how` it was made, for analytics. */
  onSeen: (item: AttentionItem, how: "swipe" | "tap") => void;
  /** A card came to the top while the Inbox is on screen (analytics: its dwell clock starts). */
  onShown?: (item: AttentionItem) => void;
  /** Archive the chat: done, it leaves the Inbox. */
  onArchive: (item: AttentionItem) => void;
  /** Take back the last Next or Archive: "seen" → unmark seen, "archive" → restore the chat. */
  onUndo: (item: AttentionItem, via: Swipe) => void;
  card: CardActions;
}) {
  const reduced = useReducedMotion();
  const { visible, current } = deck;
  const { deckRef, width } = useDeckWidth(!!current);

  const running = items.filter((i) => i.status === "running").length;
  const approval = !!current?.pendingApproval;

  const { leaving, undo, refused, said, commit, undoLast, flashRefused } = usePass({ deck, reduced, onSeen, onArchive, onUndo, onCommit: () => swipe.clear() });
  const swipe = useSwipe({ width, approval, current, onCommit: (item, via) => commit(item, via, "swipe"), onRefuse: flashRefused });
  const currentId = current ? idOf(current) : null;
  useEffect(() => {
    if (current && !hidden) onShown?.(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, hidden]);

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
        <EmptyDeck available={available} loaded={loaded} banner={banner} running={running} passedOver={catchUpQueue(items).length} onAgain={deck.again} pass={deck.pass} backLabel={backLabel} onClose={onClose} onConnection={onConnection} />
      ) : (
        <>
          <div ref={deckRef} className="loki-phone-deck">
            <Reveal dx={swipe.drag?.dx ?? 0} width={width} approval={approval} />
            <Stack visible={visible} leaving={leaving} drag={swipe.drag} release={swipe.release} width={width} approval={approval} refused={refused} reduced={reduced} conversation={conversation} handlers={swipe.handlers} deck={deck} banner={banner} card={card} onOpen={onOpen} />
          </div>
          <Decisions
            item={current}
            onOpen={() => onOpen(current)}
            onSeen={() => commit(current, "seen")}
            onApprove={(behavior) => {
              if (!current.pendingApproval) return;
              onApprove(current, current.pendingApproval.requestId, behavior);
              commit(current, behavior === "allow" ? "approve" : "deny");
            }}
          />
        </>
      )}
    </div>
  );
}

/**
 * No card up: still reading (a card's shape), or why (loki not running, the Mac unreachable, every chat moved past), what
 * this visit did, and what to do next.
 */
function EmptyDeck({ available, loaded, banner, running, passedOver, onAgain, pass, backLabel, onClose, onConnection }: { available: boolean; loaded: boolean; banner?: ReactNode; running: number; /** Chats this visit went past; the badge still counts the ones that need you. */ passedOver: number; onAgain: () => void; pass: PassSummary; backLabel: string; onClose: () => void; onConnection: () => void }) {
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
  const title = !available ? "loki is not running on the Mac" : banner ? "The Mac is out of reach" : again ? "You've been through every chat" : "You're caught up";
  const line = !available
    ? "Open loki on the Mac."
    : banner
      ? "Cards come back when it reconnects; nothing in the Inbox is lost."
      : again
        ? `${passedOver === 1 ? "1 chat still needs" : `${passedOver} chats still need`} you. Every chat stays until you archive it.`
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

/** Under the top card while it is dragged right: Next. A left drag reveals nothing (it springs back), nor does an approval. */
function Reveal({ dx, width, approval }: { dx: number; width: number; approval: boolean }) {
  const read = !approval && dx > 0 ? revealOpacity(dx, width) : 0;

  // Past the commit distance the word under the card pops (phone.css): letting go now does it.
  const ready = !approval && armed(dx, width);
  return (
    <div aria-hidden className="loki-phone-reveal">
      <span className="loki-phone-reveal-read" data-armed={(ready && dx > 0) || undefined} style={{ opacity: read, transform: `scale(${0.9 + read * 0.1})` }}>
        <Icon name="check" size={20} /> Next
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
function Stack({ visible, leaving, drag, release, width, approval, refused, reduced, conversation, handlers, deck, banner, card, onOpen }: { visible: AttentionItem[]; leaving: Leaving | null; drag: { dx: number } | null; release: Release | null; width: number; approval: boolean; refused: boolean; reduced: boolean; conversation: (agentId: string, conversationId: string) => CardView; handlers: CardHandlers; deck: Deck; banner?: ReactNode; card: CardActions; onOpen: (item: AttentionItem) => void }) {
  const dx = drag?.dx ?? 0;
  // Every move is a spring (kit/spring.ts): the cards behind rise on the smooth one; a card let go springs
  // home on the snappy one, or flies off on the smooth one, either way carrying the finger's speed.
  const rise = spring("smooth");
  const move = reduced ? "none" : `transform ${rise.ms}ms ${rise.easing}`;
  const flyTo = leaving ? leaving.dir * (width + FLY_PAST) : 0;
  // Only the card that was let go carries the speed: a card sent off by a button, or rising into the top place, starts still.
  const flung = leaving && release?.committed && release.id === idOf(leaving.item) ? release : null;
  const fly = spring("smooth", flung ? flingVelocity(flung.dx, flyTo, flung.v) : 0);
  const homeFrom = (item: AttentionItem) => (release && !release.committed && release.id === idOf(item) ? spring("snappy", flingVelocity(release.dx, 0, release.v)) : rise);
  return cardsToDraw(visible, leaving?.item ?? null).map(({ item, role, index }) => {
    if (role === "leaving")
      return (
        <Card key={idOf(item)} item={item} role={role} style={{ zIndex: 3, transform: `translateX(${flyTo}px) rotate(${leaving!.dir * 12}deg)`, opacity: 0, transition: reduced ? "none" : `transform ${fly.ms}ms ${fly.easing}, opacity ${fly.ms}ms ease-in` }}>
          <ReadOnlyThread item={item} view={conversation(item.agentId, item.id)} />
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
          style={{ zIndex: 2, transform: drag ? `translateX(${offset}px) rotate(${rotationFor(offset, width)}deg)` : "none", transition: drag || reduced ? "none" : `transform ${homeFrom(item).ms}ms ${homeFrom(item).easing}` }}
          handlers={handlers}
          onOpen={() => {
            openFromCard(); // the conversation grows out of the card (transitions.ts)
            onOpen(item);
          }}
        >
          <CardConversation item={item} view={conversation(item.agentId, item.id)} banner={banner} card={card} onHold={() => deck.hold(item)} />
        </Card>
      );
    }
    const pose = stackPose(index);
    return <Card key={idOf(item)} item={item} role={role} veil={1 - pose.opacity} style={{ zIndex: 1 - index, transform: `translateY(${pose.offsetY}px) scale(${pose.scale})`, transition: move }} />;
  });
}

/**
 * The card: who it is with (a button that opens the desk), then the body. Only the top card is live;
 * the ones behind are its frame and head under a veil, and the one flying off is inert.
 */
function Card({ item, role, refused = false, veil = 0, style, handlers, onOpen, children }: { item: AttentionItem; role: Role; refused?: boolean; /** 0..1: how much of the veil sits over a card behind the top one. */ veil?: number; style: CSSProperties; handlers?: CardHandlers; onOpen?: () => void; children?: ReactNode }) {
  const top = role === "top";
  const title = item.title ?? item.id;
  return (
    <article className="loki-phone-card" data-role={role} data-refused={refused || undefined} aria-label={top ? `${title}, with ${item.agentName ?? "the agent"}` : undefined} aria-hidden={!top || undefined} inert={!top} {...(top ? handlers : {})} style={style}>
      <header className="loki-phone-card-head">
        <button type="button" className="loki-phone-card-who" onClick={onOpen} aria-label={`Open ${title} with ${item.agentName ?? "the agent"}`} tabIndex={top ? undefined : -1}>
          <Avatar name={item.agentName} src={avatarUrl(item.agentId)} size={28} />
          <span className="loki-phone-ellipsis">{item.agentName ?? "agent"}</span>
          <Icon name="chevron-down" size={16} />
        </button>
        <span className="loki-phone-card-desk">
          <span className="loki-phone-ellipsis">{title}</span>
          <span aria-hidden>·</span>
          <span className="loki-phone-card-when">{waitingSince(item)}</span>
        </span>
      </header>
      {children && <div className="loki-phone-card-body loki-phone-thread">{children}</div>}
      {/* Cards behind the top one are dimmed by an opaque veil, not opacity, so the stack does not show through itself. */}
      {veil > 0 && <div aria-hidden className="loki-phone-card-veil" style={{ opacity: veil }} />}
    </article>
  );
}

/**
 * The top card's conversation: the shared chat surface with the phone's message layout, the unread line,
 * the notice (or the link state while the Mac is out of reach), and a message box whose draft lives in
 * session.ts under this conversation's key — the same draft the desk page shows. A message or an answer
 * from here holds the card on top until you decide it. Approve and deny are the buttons under the card.
 */
export function CardConversation({ item, view, banner, card, onHold }: { item: AttentionItem; view: CardView; banner?: ReactNode; card: CardActions; onHold: () => void }) {
  const [draft, setDraft] = useDraft(draftKey(item.agentId, item.id));
  const agentName = item.agentName ?? "the agent";
  const people = useMemo(() => ({ assistant: { name: item.agentName ?? "agent", avatar: avatarUrl(item.agentId) }, user: { name: "You" } }), [item.agentName, item.agentId]);
  const dividerAt = unreadBoundary(view.rows, item.unread, item.seenAt, item.viewedAt);
  // The chat's widgets, drawn under the rows that made them; read only here (the phone may not change a desk).
  const { widgets, inline } = useInlineWidgets(undefined, scopeFor(item.id, item.agentId), view.rows, item.agentName ?? null, { readOnly: true });
  const layout = useMemo(() => ({ people, dividerAt, dividerDay: dayLabel(item.lastMessageAt), widgets, inline }), [people, dividerAt, item.lastMessageAt, widgets, inline]);
  const question = view.question ?? null;
  const approval = view.pending ?? item.pendingApproval;
  const said = cardNotice(item, view.status);
  const notice =
    banner ??
    (said && (
      <div className="loki-phone-notice">
        <span className="loki-phone-ellipsis">{said}</span>
      </div>
    ));
  const model = card.model;
  const message = useMessageActions({ user: "You", assistant: item.agentName ?? "Agent" });
  return message.wrap(
    <>
      {message.sheet}
      <Conversation
        touch
        dim={false}
        view={{ rows: view.rows, status: view.status, error: item.status === "failed" ? (item.error ?? view.error ?? null) : (view.error ?? null), approval, question, model: model?.modelOf(item) ?? null, reasoningEffort: model?.effortOf(item) ?? null, older: view.older ?? null }}
        models={model?.models ?? null}
        actions={{
          onLoadModels: model?.onLoad,
          onPickModel: model?.onPick ? (selection) => model.onPick!(item, selection) : undefined,
          onSend: (text, images = []) => card.onSend(item, text, images),
          onAnswer: question
            ? (answers) => {
                card.onAnswer(item, question.requestId, answers);
                onHold();
              }
            : undefined,
          onCancelQueued: (text) => card.onCancelQueued(item, text),
          onStop: card.onStop ? () => card.onStop!(item) : undefined,
        }}
        agentName={agentName}
        layout={layout}
        notice={notice || null}
        placeholder={question ? "Answer, or pick above" : approval ? "Reply, or decide below" : `Message ${agentName}`}
        draft={{ value: draft, onChange: setDraft }}
        onSent={onHold}
      />
    </>,
  );
}

/** The card flying off: its thread as it was, nothing to type into. */
function ReadOnlyThread({ item, view }: { item: AttentionItem; view: CardView }) {
  return <Thread rows={view.rows} status={view.status} agentName={item.agentName} dim={false} older={view.older ?? null} />;
}

/**
 * The two big buttons under the card: Open chat (the card's conversation, full screen, where its actions
 * sheet can archive it) and Next, or — for an approval, which leaves only by its decision — Deny and Approve. The same two elements in both cases, so focus stays put as the
 * next card comes up.
 */
function Decisions({ item, onOpen, onSeen, onApprove }: { item: AttentionItem; onOpen: () => void; onSeen: () => void; onApprove: (behavior: "allow" | "deny") => void }) {
  const approval = !!item.pendingApproval;
  return (
    <div className="loki-phone-decide">
      <button type="button" className={approval ? "loki-phone-decide-btn loki-phone-decide-btn--deny" : "loki-phone-decide-btn"} onClick={approval ? () => onApprove("deny") : onOpen} aria-label={approval ? `Deny ${item.pendingApproval!.toolName}` : "Open chat"}>
        {approval ? "Deny" : "Open chat"}
      </button>
      <button type="button" className="loki-phone-decide-btn loki-phone-decide-btn--affirm" onClick={approval ? () => onApprove("allow") : onSeen} aria-label={approval ? `Approve ${item.pendingApproval!.toolName}` : undefined}>
        {approval ? "Approve" : "Next"}
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
