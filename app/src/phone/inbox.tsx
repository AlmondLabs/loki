import { useEffect, useEffectEvent, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { LabelView } from "../../../core/labels.ts";
import type { AccountProvider, OutsideSeed } from "../../../core/frame-types.ts";
import { LabelChips } from "../chat/labels";
import { archivable, offersAlways, type AttentionItem, type PendingApproval, type PendingQuestion } from "../../../core/attention/model.ts";
import type { Attachment } from "../../../core/attention/content.ts";
import { catchUpQueue, idOf, restingCount } from "../../../core/attention/queue.ts";
import { useConversation, type ChatViews, type FlowLane, type HandoffSource, type OutsideSource } from "../../../core/attention/use-attention.ts";
import { otherLanesCount } from "../../../core/attention/lanes.ts";
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
import { useOutsideReply } from "../shared/outside-replies";
import { TopBar } from "./ui";
import { ThreadNotice, replyPlaceholder, useThreadLayout } from "./thread-parts";
import { openFromCard } from "./transitions";
import { OutsideReply, OutsideThread, quoteOf, useMailCompose, useOutsideThread, wentTo } from "../desk/outside-card";
import { disconnectedText, freshSeeds, outsideTitle, outsideWho } from "../desk/outside-words";
import { senderName } from "../desk/mail-thread";
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
  otherLanesLine,
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
import { LaneSheet, LaneTitle } from "./lane-sheet";
import { newId } from "../shared/new-id";

export interface InboxMoves extends CardMoves {
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
  commit: (item: AttentionItem, via: Via) => boolean;
  undo: (item: AttentionItem, via: Via, wasHeld: boolean) => void;
  hold: (item: AttentionItem) => void;
  again: () => void;
  restingToo: () => void;
  resting: boolean;
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
    commit: (item, via) => {
      if (!canCommit(item, via)) return false;
      setState((s) => commitCard(s, item, via));
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
interface Leaving {
  item: AttentionItem;
  dir: 1 | -1;
}

const UNDO_NAME: Record<Move, string> = { seen: "Undo Read", later: "Undo Later", archive: "Undo Archive" };

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

type Refusal = "approval" | "main" | "jira" | "typed" | "sending";
const REFUSED: Record<Refusal, string> = {
  approval: "This one needs Approve or Deny.",
  main: "A main chat cannot be archived.",
  jira: "A Jira card ends only with Read.",
  typed: "Send the reply first, or use the buttons.",
  sending: "The reply is still sending.",
};

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
  const commit = (item: AttentionItem, via: Via, how: "swipe" | "tap" = "tap", opts: { until?: string; done?: boolean } = {}) => {
    const held = deck.heldId === idOf(item);
    onCommit(item);
    if (!deck.commit(item, via)) {
      flashRefused(item.pendingApproval ? "approval" : item.outside ? "jira" : "main");
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
      deck.commit(item, via);
      onNote(err);
    });
  };
  return { leaving, undo, refused, said, commit, undoLast, flashRefused };
}

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
  typed: boolean;
  sending: boolean;
  current: AttentionItem | undefined;
  onCommit: (item: AttentionItem, via: Swipe) => void;
  onRefuse: (why: Refusal) => void;
}) {
  const [drag, setDrag] = useState<{ dx: number } | null>(null);
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

interface Release {
  id: string;
  committed: boolean;
  dx: number;
  v: number;
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
  labelList?: readonly LabelView[] | null;
  items: AttentionItem[];
  loaded: boolean;
  available: boolean;
  hidden?: boolean;
  banner?: ReactNode;
  chats: ChatViews & Partial<HandoffSource> & Partial<OutsideSource> & { flow?: FlowLane };
  deck: Deck;
  backLabel: string;
  onClose: () => void;
  onOpen: (item: AttentionItem) => void;
  onConnection: () => void;
  onApprove: (item: AttentionItem, requestId: string, behavior: "allow" | "deny" | "always") => void;
  onShown?: (item: AttentionItem) => void;
  moves: InboxMoves;
  onNote: (text: string) => void;
  card: CardActions;
}) {
  const reduced = useReducedMotion();
  const { visible, current } = deck;
  const { deckRef, width } = useDeckWidth(!!current);
  const flow = chats.flow;
  const lane = flow?.lane ?? null;
  const laneCards = flow?.laneItems ?? items;
  const others = otherLanesLine(otherLanesCount(items, lane));
  const [pickingLane, setPickingLane] = useState(false);

  const running = laneCards.filter((i) => i.status === "running").length;
  const approval = !!current?.pendingApproval;
  const currentId = current ? idOf(current) : null;
  const [typedId, setTypedId] = useState<string | null>(null);
  const [keptReply] = useOutsideReply(current?.outside ? currentId : null);
  const typed = !!currentId && (typedId === currentId || !!keptReply.trim());
  const [sendingId, setSendingId] = useState<string | null>(null);
  const sending = !!currentId && sendingId === currentId;
  const [seedsTaken, setSeedsTaken] = useState<SeedsTaken>({ card: null, taken: [] });
  const boxSeeds = current?.outside && chats.readOutside && chats.replyOutside ? current.outside.seeds : undefined;
  const took = takeSeeds(seedsTaken, currentId, boxSeeds);
  if (took) {
    setSeedsTaken(took.next);
    if (took.lock) setTypedId(currentId);
  }
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

  const needYou = catchUpQueue(laneCards).length;

  const rootRef = useRef<HTMLDivElement>(null);
  const hasCard = !!current;
  const settled = useRef(false);
  useEffect(() => {
    const a = document.activeElement;
    const first = !settled.current;
    settled.current = true;
    if (first || hidden || (a && a !== document.body && a.isConnected)) return;
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
        title={flow ? <LaneTitle lane={lane} onOpen={() => setPickingLane(true)} /> : "Flow"}
        sub={
          current
            ? [needYou ? `${needYou} need you` : `${visible.length} ${visible.length === 1 ? "chat" : "chats"}`, others].filter(Boolean).join(" · ")
            : undefined
        }
        right={undo ? <UndoButton key={idOf(undo.item)} via={undo.via} onUndo={undoLast} /> : undefined}
        banner={current ? undefined : banner}
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
          passedOver={needYou}
          onAgain={deck.again}
          resting={deck.resting ? 0 : restingCount(laneCards)}
          others={others}
          onEverything={lane && flow ? () => flow.setLaneId("") : undefined}
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
            onArchive={!current.outside || archivable(current) ? () => commit(current, "archive") : undefined}
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
      {pickingLane && flow && <LaneSheet flow={flow} items={items} onClose={() => setPickingLane(false)} />}
      {labelling && (
        <MailLabelsSheet load={() => moves.labelsOf(labelling)} onAdd={(ids) => moves.label(labelling, ids, "tap")} onClose={() => setLabelling(null)} />
      )}
    </div>
  );
}

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
  others = null,
  onEverything,
}: {
  others?: string | null;
  onEverything?: () => void;
  available: boolean;
  loaded: boolean;
  banner?: ReactNode;
  running: number;
  passedOver: number;
  onAgain: () => void;
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
        <SkeletonCard label="Reading Flow…" />
      </div>
    );
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
      ? "Cards come back when it reconnects; nothing in Flow is lost."
      : again
        ? `${passedOver === 1 ? "1 chat still needs" : `${passedOver} chats still need`} you. Every chat stays until you archive it.`
        : resting > 0
          ? resting === 1
            ? "1 chat rests until it's due or something new comes."
            : `${resting} chats rest until they're due or something new comes.`
          : running > 0
            ? `${running} still running. They land here when they finish.`
            : "Nothing is waiting on you.";
  const done = loaded && !macProblem;
  return (
    <>
      <div className="loki-phone-scroll loki-phone-scroll--flush">
        <div className="loki-phone-empty" role="status" data-done={done || undefined}>
          <Icon name={macProblem ? "laptop" : "check"} size={32} className="loki-phone-empty-mark" />
          <p className="loki-phone-headline">{title}</p>
          <p>{line}</p>
          {summary && <p className="loki-phone-meta">This visit: {summary}</p>}
          {!macProblem && others && <p className="loki-phone-meta">{others}</p>}
          {macProblem ? (
            <Button size="touch" tone="paper" onClick={onConnection}>
              Connection Details
            </Button>
          ) : (
            <div className="loki-phone-empty-actions">
              {again && (
                <Button size="touch" tone="paper" onClick={onAgain}>
                  Go Through Again
                </Button>
              )}
              {!again && resting > 0 && (
                <Button size="touch" tone="paper" onClick={onResting}>
                  Go Through Them
                </Button>
              )}
              {onEverything && (
                <Button size="touch" tone="paper" onClick={onEverything}>
                  Back to Everything
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

function Reveal({ dx, width, approval }: { dx: number; width: number; approval: boolean }) {
  const shown = approval ? 0 : revealOpacity(dx, width);
  const read = dx > 0 ? shown : 0;
  const later = dx < 0 ? shown : 0;

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
}: {
  onTyped: (item: AttentionItem, has: boolean) => void;
  onSending: (item: AttentionItem, on: boolean) => void;
  labelList: readonly LabelView[] | null;
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
  const [suggestTick, setSuggestTick] = useState<ChatTick>(null);
  const rise = spring("smooth");
  const move = reduced ? "none" : `transform ${rise.ms}ms ${rise.easing}`;
  const flyTo = leaving ? leaving.dir * (width + FLY_PAST) : 0;
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
            item.outside
              ? undefined
              : () => {
                  openFromCard();
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
              outside={
                chats.readOutside && chats.replyOutside
                  ? {
                      readOutside: chats.readOutside,
                      replyOutside: chats.replyOutside,
                      composeOutside: chats.composeOutside,
                      unsendOutside: chats.unsendOutside,
                      searchPeople: chats.searchPeople,
                      pickPerson: chats.pickPerson,
                      sentReplies: chats.sentReplies,
                    }
                  : null
              }
              onTyped={(has) => onTyped(item, has)}
              onSending={(on) => onSending(item, on)}
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

const OUTSIDE_NAMED: Record<AccountProvider, boolean> = { gmail: true, slack: false, jira: true };

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
  suggestions?: number;
  onSuggestions?: () => void;
  labelList?: readonly LabelView[] | null;
  refused?: boolean;
  veil?: number;
  style: CSSProperties;
  handlers?: CardHandlers;
  onOpen?: () => void;
  children?: ReactNode;
}) {
  const top = role === "top";
  const named = item.outside ? OUTSIDE_NAMED[item.outside.provider] : false;
  const title = item.outside ? (named ? outsideTitle(item.outside) : outsideWho(item.outside)) : (item.title ?? item.id);
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
          {item.outside && named && (
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
      {veil > 0 && <div aria-hidden className="loki-phone-card-veil" style={{ opacity: veil }} />}
    </article>
  );
}

function LiveCardConversation({ chats, ...card }: { chats: ChatViews } & Omit<Parameters<typeof CardConversation>[0], "view">) {
  const view = useConversation(chats, card.item.agent_id, card.item.id);
  return <CardConversation {...card} view={view} />;
}

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

function OutsideBody({
  item,
  banner,
  went = null,
  handoff = null,
  outside = null,
  onTyped,
  onSending,
}: {
  item: AttentionItem;
  banner?: ReactNode;
  went?: string | null;
  handoff?: HandoffSource | null;
  outside?: OutsideSource | null;
  onTyped?: (has: boolean) => void;
  onSending?: (on: boolean) => void;
}) {
  const [picking, setPicking] = useState(false);
  const thread = useOutsideThread(item, outside);
  const compose = useMailCompose(item, outside);
  const held = useRef<string | null>(null);
  const facts = item.outside;
  if (!facts) return null;
  const unsend = outside?.unsendOutside;
  const settle = outside?.settleUnsent;
  const people = outside?.searchPeople;
  const pick = outside?.pickPerson;
  return (
    <div style={{ padding: "var(--phone-space-3) var(--phone-gutter)", display: "flex", flexDirection: "column", gap: "var(--phone-space-3)" }}>
      {banner}
      {facts.disconnected && <ThreadNotice text={sentence(disconnectedText(facts.disconnected, facts.provider))} />}
      {went && <span className="loki-phone-meta">{sentence(went)}</span>}
      <OutsideThread facts={facts} state={thread} touch />
      {outside && (
        <div
          onPointerDown={stopPointer}
          onPointerMove={stopPointer}
          onPointerUp={stopPointer}
          onInput={(e) => e.target instanceof HTMLTextAreaElement && onTyped?.(!!e.target.value.trim())}
        >
          <OutsideReply
            facts={facts}
            keep={idOf(item)}
            touch
            compose={compose}
            quote={quoteOf(facts, thread)}
            searchPeople={people ? (q) => people(item, q).then((r) => (typeof r === "string" ? [] : r)) : undefined}
            onPickPerson={pick ? (p) => pick(item, p) : undefined}
            inThread={thread.kind === "read" && !!thread.opened}
            onUnsent={settle ? (outboxId, action) => settle(item, outboxId, action) : undefined}
            onUndo={
              facts.provider === "gmail" && unsend
                ? () => {
                    if (held.current) void unsend(item, held.current);
                  }
                : undefined
            }
            onSend={async (text, mail) => {
              onSending?.(true);
              const outboxId = facts.provider === "gmail" && unsend ? newId() : null;
              held.current = outboxId;
              try {
                const threadTs = thread.kind === "read" ? (thread.opened ?? null) : null;
                const r = await outside.replyOutside(item, text, "stay", { mail, outbox_id: outboxId, ...(threadTs ? { thread_ts: threadTs } : {}) });
                if (r.sent) onTyped?.(false);
                return r;
              } finally {
                held.current = null;
                onSending?.(false);
              }
            }}
          />
        </div>
      )}
      {handoff &&
        (picking ? (
          <HandoffPicker item={item} source={handoff} touch onCancel={() => setPicking(false)} onDone={() => setPicking(false)} />
        ) : (
          <Button
            size="touch"
            tone="positive"
            disabled={!!facts.disconnected}
            onClick={() => setPicking(true)}
            aria-label={`Hand Off to ${facts.owner_name ?? "its agent"}`}
          >
            Hand Off
          </Button>
        ))}
    </div>
  );
}

const stopPointer = (e: { stopPropagation: () => void }) => e.stopPropagation();

function ReadOnlyThread({ item, chats }: { item: AttentionItem; chats: ChatViews }) {
  const view = useConversation(chats, item.agent_id, item.id);
  return (
    <Thread
      phone
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
  sending?: boolean;
  onRead: () => void;
  onLater: () => void;
  onArchive?: () => void;
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
        {offersAlways(approval) && (
          <button type="button" className="loki-phone-decide-always" onClick={() => onApprove("always")} aria-label={`Always allow ${approval.toolName}`}>
            Always allow {approval.toolName}
          </button>
        )}
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
      {onArchive && (
        <button type="button" className="loki-phone-decide-btn" onClick={onArchive} disabled={sending}>
          Archive
        </button>
      )}
      <button type="button" className="loki-phone-decide-btn loki-phone-decide-btn--affirm" onClick={onRead} disabled={sending}>
        Read
      </button>
    </div>
  );
}

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
