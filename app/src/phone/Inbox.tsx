import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { AttentionItem, PendingApproval, PendingQuestion } from "../../../core/attention/model.ts";
import type { ImageAttachment } from "../../../core/attention/content.ts";
import { catchUpQueue, idOf, snoozedItems } from "../../../core/attention/queue.ts";
import { formatIn } from "../../../core/attention/snooze.ts";
import { formatInput } from "../../../core/attention/format.ts";
import type { TranscriptRow } from "../chat/Transcript";
import { Conversation, Thread } from "../chat/Conversation";
import { avatarUrl } from "../desk/env";
import { Button } from "../components";
import { COMPOSER_ICONS } from "./Conversation";
import { waitingSince } from "./model";
import { Icon } from "./icons";
import { Avatar, RowSection } from "./rows";
import { draftKey, useDraft } from "./session";
import { TopBar } from "./ui";
import {
  DRAG_SLOP,
  EMPTY_DECK,
  FLY_EASE,
  FLY_MS,
  UNDO_MS,
  canCommit,
  cardNotice,
  cardsToDraw,
  commitCard,
  dayLabel,
  deckQueue,
  holdCard,
  isHorizontalDrag,
  passTotal,
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
 * can be read and answered without leaving the pass. Under it, Later and Mark as Read; swipe left for
 * Later, right for Mark as Read. Approvals refuse both, and the two buttons become Deny and Approve.
 * Undo sits in the top bar for six seconds after Later or Mark as Read. The pure parts (when a drag
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
}

/**
 * A pass, held by the parent (Phone.tsx) beside the transcripts it fetches for the top card, so it
 * survives the Inbox being out of sight: the cards in order, the one on top, the tally, and the card
 * held after a reply. `commit` is false when the card refuses that way off (Later on an approval).
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
  /** A fresh pass: the cards passed over in this one (a question sent to Later, which never snoozes) come back. */
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

/**
 * What a pass does on screen as cards go: the card flying off (for FLY_MS, unless motion is reduced),
 * the Undo button's card (for UNDO_MS after Later or Mark as Read), the flash when an approval refuses,
 * and the sentence a screen reader hears. `commit` takes the card off and tells the parent; `undoLast`
 * puts the last one back.
 */
function usePass({ deck, reduced, onSeen, onLater, onUndo, onCommit }: { deck: Deck; reduced: boolean; onSeen: (item: AttentionItem) => void; onLater: (item: AttentionItem) => void; onUndo: (item: AttentionItem, via: Swipe) => void; onCommit: () => void }) {
  const [leaving, setLeaving] = useState<{ item: AttentionItem; dir: 1 | -1 } | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [refused, setRefused] = useState(false);
  const [said, setSaid] = useState("");
  const undoTimer = useTimer();
  const leaveTimer = useTimer();
  const refuseTimer = useTimer();

  const flashRefused = () => {
    setRefused(true);
    setSaid("This one needs Approve or Deny.");
    refuseTimer.set(() => setRefused(false), 420);
  };
  const commit = (item: AttentionItem, via: Via) => {
    const held = deck.heldId === idOf(item);
    if (!deck.commit(item, via)) {
      onCommit();
      flashRefused();
      return;
    }
    onCommit();
    if (via === "seen") onSeen(item);
    else if (via === "later") onLater(item);
    const rest = deck.visible.filter((i) => idOf(i) !== idOf(item));
    setSaid(reviewAnnouncement(via, rest[0], rest.length));
    if (!reduced) {
      setLeaving({ item, dir: via === "later" || via === "deny" ? -1 : 1 });
      leaveTimer.set(() => setLeaving((l) => (l && idOf(l.item) === idOf(item) ? null : l)), FLY_MS + 30);
    }
    undoTimer.clear();
    if (via === "seen" || via === "later") {
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
  const start = useRef<{ x: number; y: number; id: number; dragging: boolean; samples: { x: number; t: number }[] } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if ((e.target as Element).closest(OWN_GESTURE)) return;
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId, dragging: false, samples: [{ x: e.clientX, t: e.timeStamp }] };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const s = start.current;
    if (!s || s.id !== e.pointerId) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (!s.dragging) {
      if (!isHorizontalDrag(dx, dy)) return;
      s.dragging = true;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* a pointer that already left */
      }
    }
    s.samples.push({ x: e.clientX, t: e.timeStamp });
    if (s.samples.length > 12) s.samples.shift();
    setDrag({ dx });
  };
  const finish = (e: ReactPointerEvent<HTMLElement>, cancelled: boolean) => {
    const s = start.current;
    if (!s || s.id !== e.pointerId) return;
    start.current = null;
    if (!s.dragging) return;
    const dx = e.clientX - s.x;
    if (cancelled || !current) {
      setDrag(null);
      return;
    }
    const decision = swipeDecision(dx, width, velocityOf(s.samples), { approval });
    if (decision) onCommit(current, decision);
    else {
      setDrag(null);
      if (approval && Math.abs(dx) > DRAG_SLOP * 2) onRefuse();
    }
  };
  const handlers: CardHandlers = { onPointerDown, onPointerMove, onPointerUp: (e) => finish(e, false), onPointerCancel: (e) => finish(e, true) };
  return { drag, clear: () => setDrag(null), handlers };
}

/** What the card's conversation can do: reply (text, images), answer the open question, take back a queued message. */
export interface CardActions {
  onSend: (item: AttentionItem, text: string, images: ImageAttachment[]) => void;
  onAnswer: (item: AttentionItem, requestId: string, answers: Record<string, string | string[]>) => void;
  onCancelQueued: (item: AttentionItem, text: string) => void;
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
  onLater,
  onUnsnooze,
  onUndo,
  card,
}: {
  items: AttentionItem[];
  /** The app-server has answered at least once; before that an empty list means nothing. */
  loaded: boolean;
  /** The mod found an app-server to tunnel to; without one there is no inbox to read. */
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
  onSeen: (item: AttentionItem) => void;
  onLater: (item: AttentionItem) => void;
  onUnsnooze: (item: AttentionItem) => void;
  /** Take back the last Later or Mark as Read: "seen" → unmark seen, "later" → clear the snooze. */
  onUndo: (item: AttentionItem, via: Swipe) => void;
  card: CardActions;
}) {
  const reduced = useReducedMotion();
  const [showDeferred, setShowDeferred] = useState(false);
  const { visible, current } = deck;
  const { deckRef, width } = useDeckWidth(!!current);

  const snoozed = snoozedItems(items);
  const running = items.filter((i) => i.status === "running").length;
  const approval = !!current?.pendingApproval;

  const { leaving, undo, refused, said, commit, undoLast, flashRefused } = usePass({ deck, reduced, onSeen, onLater, onUndo, onCommit: () => swipe.clear() });
  const swipe = useSwipe({ width, approval, current, onCommit: commit, onRefuse: flashRefused });

  const done = passTotal(deck.pass);
  const total = done + visible.length;

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
        title={current ? `${visible.length} Left` : "Inbox"}
        right={
          undo ? (
            <button type="button" className="loki-phone-undo" onClick={undoLast} aria-label={undo.via === "seen" ? "Undo Mark as Read" : "Undo Later"}>
              Undo
            </button>
          ) : undefined
        }
        progress={current && total > 0 ? done / total : null}
      />
      <div className="loki-phone-sr-only" role="status" aria-live="polite">
        {said}
      </div>

      {!current ? (
        <EmptyDeck available={available} loaded={loaded} banner={banner} running={running} passedOver={catchUpQueue(items).length} onAgain={deck.again} pass={deck.pass} snoozed={snoozed} showDeferred={showDeferred} onToggleDeferred={() => setShowDeferred((v) => !v)} onOpen={onOpen} onUnsnooze={onUnsnooze} backLabel={backLabel} onClose={onClose} onConnection={onConnection} />
      ) : (
        <>
          <div ref={deckRef} className="loki-phone-deck">
            <Reveal dx={swipe.drag?.dx ?? 0} width={width} approval={approval} />
            <Stack visible={visible} leaving={leaving} drag={swipe.drag} width={width} approval={approval} refused={refused} reduced={reduced} conversation={conversation} handlers={swipe.handlers} deck={deck} banner={banner} card={card} onOpen={onOpen} />
          </div>
          <Decisions
            item={current}
            onLater={() => commit(current, "later")}
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
 * No card up: why (no harness, the Mac unreachable, still reading, caught up), what this pass did, and
 * what to do next; the deferred cards follow as a folded section, each with Bring back.
 */
function EmptyDeck({ available, loaded, banner, running, passedOver, onAgain, pass, snoozed, showDeferred, onToggleDeferred, onOpen, onUnsnooze, backLabel, onClose, onConnection }: { available: boolean; loaded: boolean; banner?: ReactNode; running: number; /** Ready cards this pass went past; the badge still counts them. */ passedOver: number; onAgain: () => void; pass: PassSummary; snoozed: AttentionItem[]; showDeferred: boolean; onToggleDeferred: () => void; onOpen: (item: AttentionItem) => void; onUnsnooze: (item: AttentionItem) => void; backLabel: string; onClose: () => void; onConnection: () => void }) {
  const summary = summaryLine(pass);
  const macProblem = !available || !!banner;
  // Passed over is not caught up: the badge and Home still count those cards, so the words must too.
  const again = loaded && !macProblem && passedOver > 0;
  const title = !available ? "No harness on the Mac" : banner ? "The Mac is out of reach" : !loaded ? "Reading the inbox…" : again ? "End of this pass" : "You're caught up";
  const line = !available
    ? "Open loki on the Mac so its mod can find Letta's app-server."
    : banner
      ? "Cards come back when it reconnects; nothing in this pass is lost."
      : !loaded
        ? "The Mac is listing conversations."
        : again
          ? `${passedOver === 1 ? "1 card is" : `${passedOver} cards are`} still waiting on you: a question stays until it is answered.`
          : running > 0
          ? `${running} still running. They land here when they finish.`
          : "Nothing is waiting on you.";
  return (
    <>
      {banner}
      <div className="loki-phone-scroll loki-phone-scroll--flush">
        <div className="loki-phone-empty" role="status">
          <Icon name={macProblem ? "laptop" : loaded ? "check" : "inbox"} size={32} />
          <p className="loki-phone-headline">{title}</p>
          <p>{line}</p>
          {summary && <p className="loki-phone-meta">This pass: {summary}</p>}
          {macProblem ? (
            <Button size="touch" tone="paper" onClick={onConnection}>
              Connection details
            </Button>
          ) : loaded ? (
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
          ) : null}
        </div>
        {snoozed.length > 0 && (
          <RowSection icon="clock" title="Later" count={snoozed.length} open={showDeferred} onToggle={onToggleDeferred}>
            <ul className="loki-phone-list">
              {snoozed.map((item) => (
                <DeferredRow key={idOf(item)} item={item} onOpen={() => onOpen(item)} onUnsnooze={() => onUnsnooze(item)} />
              ))}
            </ul>
          </RowSection>
        )}
      </div>
    </>
  );
}

/** A card sent to Later: the agent's face, its title, when it comes back, and Bring back beside it. */
function DeferredRow({ item, onOpen, onUnsnooze }: { item: AttentionItem; onOpen: () => void; onUnsnooze: () => void }) {
  const title = item.title ?? item.id;
  return (
    <li className="loki-phone-row-item" data-dim>
      <button type="button" className="loki-phone-row" onClick={onOpen}>
        <Avatar name={item.agentName} src={avatarUrl(item.agentId)} />
        <span className="loki-phone-row-copy">
          <span className="loki-phone-row-title">
            <span className="loki-phone-ellipsis">{title}</span>
          </span>
          <span className="loki-phone-row-preview">
            {item.agentName ?? "agent"} · back in {item.snooze ? formatIn(item.snooze.until) : "a while"}
          </span>
        </span>
      </button>
      <button type="button" className="loki-phone-row-action" onClick={onUnsnooze} aria-label={`Bring back ${title}`}>
        Bring back
      </button>
    </li>
  );
}

/** Under the top card while it is dragged: Mark as Read on the left as the card goes right, Later on the right. Approvals reveal nothing. */
function Reveal({ dx, width, approval }: { dx: number; width: number; approval: boolean }) {
  const read = !approval && dx > 0 ? revealOpacity(dx, width) : 0;
  const later = !approval && dx < 0 ? revealOpacity(dx, width) : 0;
  return (
    <div aria-hidden className="loki-phone-reveal">
      <span className="loki-phone-reveal-read" style={{ opacity: read, transform: `scale(${0.9 + read * 0.1})` }}>
        <Icon name="check" size={20} /> Mark as Read
      </span>
      <span className="loki-phone-reveal-later" style={{ opacity: later, transform: `scale(${0.9 + later * 0.1})` }}>
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
function Stack({ visible, leaving, drag, width, approval, refused, reduced, conversation, handlers, deck, banner, card, onOpen }: { visible: AttentionItem[]; leaving: { item: AttentionItem; dir: 1 | -1 } | null; drag: { dx: number } | null; width: number; approval: boolean; refused: boolean; reduced: boolean; conversation: (agentId: string, conversationId: string) => CardView; handlers: CardHandlers; deck: Deck; banner?: ReactNode; card: CardActions; onOpen: (item: AttentionItem) => void }) {
  const dx = drag?.dx ?? 0;
  const move = reduced ? "none" : `transform ${FLY_MS}ms ${FLY_EASE}, opacity ${FLY_MS}ms ${FLY_EASE}`;
  return cardsToDraw(visible, leaving?.item ?? null).map(({ item, role, index }) => {
    if (role === "leaving")
      return (
        <Card key={idOf(item)} item={item} role={role} style={{ zIndex: 3, transform: `translateX(${leaving!.dir * (width + 80)}px) rotate(${leaving!.dir * 12}deg)`, opacity: 0, transition: move }}>
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
          style={{ zIndex: 2, transform: drag ? `translateX(${offset}px) rotate(${rotationFor(offset, width)}deg)` : "none", transition: drag ? "none" : move }}
          handlers={handlers}
          onOpen={() => onOpen(item)}
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
function CardConversation({ item, view, banner, card, onHold }: { item: AttentionItem; view: CardView; banner?: ReactNode; card: CardActions; onHold: () => void }) {
  const [draft, setDraft] = useDraft(draftKey(item.agentId, item.id));
  const agentName = item.agentName ?? "the agent";
  const people = useMemo(() => ({ assistant: { name: item.agentName ?? "agent", avatar: avatarUrl(item.agentId) }, user: { name: "You" } }), [item.agentName, item.agentId]);
  const dividerAt = unreadBoundary(view.rows, item.unread, item.seenAt, item.viewedAt);
  const layout = useMemo(() => ({ people, dividerAt, dividerDay: dayLabel(item.lastMessageAt) }), [people, dividerAt, item.lastMessageAt]);
  const question = view.question ?? null;
  const approval = view.pending ?? item.pendingApproval;
  const notice = banner ?? (
    <div className="loki-phone-notice">
      <span className="loki-phone-ellipsis">{cardNotice(item, view.status)}</span>
    </div>
  );
  return (
    <Conversation
      touch
      dim={false}
      attach
      view={{ rows: view.rows, status: view.status, error: item.status === "failed" ? (item.error ?? view.error ?? null) : (view.error ?? null), approval, question }}
      actions={{
        onSend: (text, images = []) => card.onSend(item, text, images),
        onAnswer: question
          ? (answers) => {
              card.onAnswer(item, question.requestId, answers);
              onHold();
            }
          : undefined,
        onCancelQueued: (text) => card.onCancelQueued(item, text),
      }}
      agentName={agentName}
      layout={layout}
      notice={notice}
      placeholder={question ? "Answer, or pick above" : approval ? "Reply, or decide below" : `Message ${agentName}`}
      draft={{ value: draft, onChange: setDraft }}
      icons={COMPOSER_ICONS}
      onSent={onHold}
    />
  );
}

/** The card flying off: its thread as it was, nothing to type into. */
function ReadOnlyThread({ item, view }: { item: AttentionItem; view: CardView }) {
  return <Thread rows={view.rows} status={view.status} agentName={item.agentName} dim={false} />;
}

/**
 * The two big buttons under the card; every swipe has one. Later and Mark as Read, or — for an approval,
 * which refuses both — Deny and Approve. The same two elements in both cases, so focus stays put as the
 * next card comes up.
 */
function Decisions({ item, onLater, onSeen, onApprove }: { item: AttentionItem; onLater: () => void; onSeen: () => void; onApprove: (behavior: "allow" | "deny") => void }) {
  const approval = !!item.pendingApproval;
  return (
    <div className="loki-phone-decide">
      <button type="button" className={approval ? "loki-phone-decide-btn loki-phone-decide-btn--deny" : "loki-phone-decide-btn"} onClick={approval ? () => onApprove("deny") : onLater} aria-label={approval ? `Deny ${item.pendingApproval!.toolName}` : "Later: comes back later, a little later each time"}>
        {approval ? "Deny" : "Later"}
      </button>
      <button type="button" className="loki-phone-decide-btn loki-phone-decide-btn--affirm" onClick={approval ? () => onApprove("allow") : onSeen} aria-label={approval ? `Approve ${item.pendingApproval!.toolName}` : undefined}>
        {approval ? "Approve" : "Mark as Read"}
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
