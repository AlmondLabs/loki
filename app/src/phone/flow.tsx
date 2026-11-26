import { useEffect, useEffectEvent, useRef, useState, type ReactNode, type RefObject } from "react";
import type { LabelView } from "../../../core/labels.ts";
import { offersAlways, type AttentionItem } from "../../../core/attention/model.ts";
import { catchUpQueue, idOf, restingCount } from "../../../core/attention/queue.ts";
import type { ChatViews, FlowLane, HandoffSource, OutsideSource } from "../../../core/attention/use-attention.ts";
import { otherLanesCount } from "../../../core/attention/lanes.ts";
import { Icon } from "./icons";
import { draftKey, useDraft } from "../shared/drafts";
import { useOutsideReply } from "../shared/outside-replies";
import { useReplyHold } from "../shared/reply-hold";
import { TopBar } from "./ui";
import { HandoffPicker } from "../workspace/handoff-picker";
import { cardActions, otherLanesLine, type CardActionKind, type Via } from "./deck";
import { ReturnTimeSheet } from "./return-time-sheet";
import { MailLabelsSheet } from "./mail-labels-sheet";
import { LaneSheet, LaneTitle } from "./lane-sheet";
import { Sheet } from "../components";
import { CardActionsSheet } from "./card-actions";
import { FlowHint, useFlowHint } from "./flow-hint";
import { EmptyDeck, Reveal, Stack, UndoButton, dragWords } from "./flow-card";
import {
  takeSeeds,
  useDeckWidth,
  usePass,
  useReducedMotion,
  useSwipe,
  type CardActions,
  type CardHandlers,
  type Deck,
  type Drag,
  type FlowMoves,
  type Leaving,
  type Release,
  type SeedsTaken,
} from "./use-flow-deck";

export { Card, CardConversation, dragWords } from "./flow-card";
export { takeSeeds, useDeck, type CardActions, type CardModel, type CardView, type Deck, type FlowMoves, type SeedsTaken } from "./use-flow-deck";

function flowSubtitle(hasCurrent: boolean, needYou: number, visibleCount: number, others: string | null): string | undefined {
  if (!hasCurrent) return undefined;
  const count = needYou ? `${needYou} need you` : `${visibleCount} ${visibleCount === 1 ? "chat" : "chats"}`;
  return [count, others].filter(Boolean).join(" · ");
}

function useFlowFocus(rootRef: RefObject<HTMLDivElement | null>, hasCard: boolean, hidden: boolean): void {
  const settled = useRef(false);
  useEffect(() => {
    const a = document.activeElement;
    const first = !settled.current;
    settled.current = true;
    if (first || hidden || (a && a !== document.body && a.isConnected)) return;
    rootRef.current?.querySelector<HTMLElement>("[data-phone-heading]")?.focus({ preventScroll: true });
  }, [rootRef, hasCard, hidden]);
}

function useFlowShown(current: AttentionItem | undefined, currentId: string | null, hidden: boolean, onShown?: (item: AttentionItem) => void): void {
  const shown = useEffectEvent(() => {
    if (current && !hidden) onShown?.(current);
  });
  useEffect(() => shown(), [currentId, hidden]);
}

function useFlowInputState(current: AttentionItem | undefined, currentId: string | null, chats: Partial<OutsideSource>) {
  const [typedId, setTypedId] = useState<string | null>(null);
  const [keptReply] = useOutsideReply(current?.outside ? currentId : null);
  const [chatDraft] = useDraft(current && !current.outside ? draftKey(current.agent_id, current.id) : null);
  const typedHere = !!currentId && (typedId === currentId || !!keptReply.trim());
  const typed = typedHere || (!!currentId && (!!chatDraft.text.trim() || chatDraft.images.length > 0));
  useReplyHold(typedHere);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [seedsTaken, setSeedsTaken] = useState<SeedsTaken>({ card: null, taken: [] });
  const boxSeeds = current?.outside && chats.readOutside && chats.replyOutside ? current.outside.seeds : undefined;
  const took = takeSeeds(seedsTaken, currentId, boxSeeds);
  if (took) {
    setSeedsTaken(took.next);
    if (took.lock) setTypedId(currentId);
  }
  return { typed, sending: !!currentId && sendingId === currentId, typedId, setTypedId, setSendingId };
}

function useFlowModals(currentId: string | null) {
  const [asking, setAsking] = useState<{ item: AttentionItem; how: "swipe" | "tap" } | null>(null);
  const [labelling, setLabelling] = useState<AttentionItem | null>(null);
  const [handingOff, setHandingOff] = useState<AttentionItem | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  if (menuFor && menuFor !== currentId) setMenuFor(null);
  return { asking, setAsking, labelling, setLabelling, handingOff, setHandingOff, menuFor, setMenuFor };
}

function dispatchCardAct({
  item,
  via,
  how,
  moves,
  onApprove,
  commit,
  clearSwipe,
  askReturn,
}: {
  item: AttentionItem;
  via: Via;
  how: "swipe" | "tap";
  moves: FlowMoves;
  onApprove: (item: AttentionItem, requestId: string, behavior: "allow" | "deny" | "always") => void;
  commit: (item: AttentionItem, via: Via, how?: "swipe" | "tap", opts?: { until?: string; done?: boolean; from?: "gesture" | "menu" }) => void;
  clearSwipe: () => void;
  askReturn: (ask: { item: AttentionItem; how: "swipe" | "tap" }) => void;
}) {
  if (via === "later") {
    if (!item.pendingApproval && moves.laterAsks(item)) {
      clearSwipe();
      askReturn({ item, how });
    } else commit(item, "later", how);
    return;
  }
  if (via === "approve" || via === "deny") {
    if (!item.pendingApproval) return;
    onApprove(item, item.pendingApproval.requestId, via === "approve" ? "allow" : "deny");
    commit(item, via, how);
    return;
  }
  commit(item, via, how);
}

function dispatchCardPick({
  item,
  action,
  setMenuFor,
  setLabelling,
  setHandingOff,
  onApprove,
  commit,
  act,
}: {
  item: AttentionItem;
  action: CardActionKind;
  setMenuFor: (id: string | null) => void;
  setLabelling: (item: AttentionItem | null) => void;
  setHandingOff: (item: AttentionItem | null) => void;
  onApprove: (item: AttentionItem, requestId: string, behavior: "allow" | "deny" | "always") => void;
  commit: (item: AttentionItem, via: Via, how?: "swipe" | "tap", opts?: { until?: string; done?: boolean; from?: "gesture" | "menu" }) => void;
  act: (item: AttentionItem, via: Via, how: "swipe" | "tap") => void;
}) {
  setMenuFor(null);
  if (action === "label") setLabelling(item);
  else if (action === "handoff") setHandingOff(item);
  else if (action === "always") {
    if (!item.pendingApproval) return;
    onApprove(item, item.pendingApproval.requestId, "always");
    commit(item, "approve", "tap");
  } else if (action === "later" && item.pendingApproval) commit(item, "later", "tap", { from: "menu" });
  else act(item, action, "tap");
}

function useFlowGestures({
  deck,
  reduced,
  moves,
  onNote,
  onApprove,
  current,
  width,
  typed,
  sending,
  typedId,
  setTypedId,
  setAsking,
  setMenuFor,
  setLabelling,
  setHandingOff,
}: {
  deck: Deck;
  reduced: boolean;
  moves: FlowMoves;
  onNote: (text: string) => void;
  onApprove: (item: AttentionItem, requestId: string, behavior: "allow" | "deny" | "always") => void;
  current: AttentionItem | undefined;
  width: number;
  typed: boolean;
  sending: boolean;
  typedId: string | null;
  setTypedId: (id: string | null) => void;
  setAsking: (ask: { item: AttentionItem; how: "swipe" | "tap" } | null) => void;
  setMenuFor: (id: string | null) => void;
  setLabelling: (item: AttentionItem | null) => void;
  setHandingOff: (item: AttentionItem | null) => void;
}) {
  const hint = useFlowHint(current);
  const { leaving, undo, refused, said, commit, undoLast, flashRefused } = usePass({
    deck,
    reduced,
    moves,
    onNote,
    onAsk: (item, how) => setAsking({ item, how }),
    onCommit: (item) => {
      swipe.clear();
      if (hint.shown) hint.dismiss();
      if (idOf(item) === typedId) setTypedId(null);
    },
  });
  const act = (item: AttentionItem, via: Via, how: "swipe" | "tap") =>
    dispatchCardAct({ item, via, how, moves, onApprove, commit, clearSwipe: swipe.clear, askReturn: setAsking });
  const pick = (item: AttentionItem, action: CardActionKind) =>
    dispatchCardPick({ item, action, setMenuFor, setLabelling, setHandingOff, onApprove, commit, act });
  const swipe = useSwipe({ width, typed, sending, current, onCommit: (item, via) => act(item, via, "swipe"), onRefuse: flashRefused });
  return { hint, leaving, undo, refused, said, commit, undoLast, pick, swipe };
}

function FlowMain({
  current,
  available,
  loaded,
  banner,
  running,
  needYou,
  deck,
  laneCards,
  others,
  lane,
  flow,
  backLabel,
  onClose,
  onConnection,
  deckRef,
  drag,
  release,
  handlers,
  leaving,
  refused,
  width,
  typed,
  sending,
  visible,
  reduced,
  chats,
  card,
  onOpen,
  labelList,
  items,
  hint,
  onMore,
  onTyped,
  onSending,
}: {
  current: AttentionItem | undefined;
  available: boolean;
  loaded: boolean;
  banner?: ReactNode;
  running: number;
  needYou: number;
  deck: Deck;
  laneCards: AttentionItem[];
  others: string | null;
  lane: FlowLane["lane"] | null;
  flow: FlowLane | undefined;
  backLabel: string;
  onClose: () => void;
  onConnection: () => void;
  deckRef: RefObject<HTMLDivElement | null>;
  drag: Drag | null;
  release: Release | null;
  handlers: CardHandlers;
  leaving: Leaving | null;
  refused: boolean;
  width: number;
  typed: boolean;
  sending: boolean;
  visible: AttentionItem[];
  reduced: boolean;
  chats: ChatViews & Partial<HandoffSource> & Partial<OutsideSource>;
  card: CardActions;
  onOpen: (item: AttentionItem) => void;
  labelList: readonly LabelView[] | null;
  items: AttentionItem[];
  hint: { shown: boolean; dismiss: () => void };
  onMore: () => void;
  onTyped: (item: AttentionItem, has: boolean) => void;
  onSending: (item: AttentionItem, on: boolean) => void;
}) {
  if (!current) {
    return (
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
    );
  }
  return (
    <div ref={deckRef} className="loki-phone-deck">
      <Reveal drag={drag} width={width} item={current} typed={typed} sending={sending} />
      <Stack
        onTyped={onTyped}
        onSending={onSending}
        visible={visible}
        leaving={leaving}
        drag={drag}
        release={release}
        width={width}
        refused={refused}
        onMore={onMore}
        reduced={reduced}
        chats={chats}
        handlers={handlers}
        deck={deck}
        banner={banner}
        card={card}
        onOpen={onOpen}
        labelList={labelList}
        items={items}
      />
      {hint.shown && <FlowHint words={`Drag the reply box. ${dragWords(current)}`} onDismiss={hint.dismiss} />}
    </div>
  );
}

function FlowSheets({
  current,
  currentId,
  items,
  flow,
  handoff,
  moves,
  typed,
  sending,
  pickingLane,
  setPickingLane,
  asking,
  setAsking,
  menuFor,
  setMenuFor,
  handingOff,
  setHandingOff,
  labelling,
  setLabelling,
  onCommitLater,
  onPickAction,
}: {
  current: AttentionItem | undefined;
  currentId: string | null;
  items: AttentionItem[];
  flow: FlowLane | undefined;
  handoff: HandoffSource | null;
  moves: FlowMoves;
  typed: boolean;
  sending: boolean;
  pickingLane: boolean;
  setPickingLane: (open: boolean) => void;
  asking: { item: AttentionItem; how: "swipe" | "tap" } | null;
  setAsking: (ask: { item: AttentionItem; how: "swipe" | "tap" } | null) => void;
  menuFor: string | null;
  setMenuFor: (id: string | null) => void;
  handingOff: AttentionItem | null;
  setHandingOff: (item: AttentionItem | null) => void;
  labelling: AttentionItem | null;
  setLabelling: (item: AttentionItem | null) => void;
  onCommitLater: (item: AttentionItem, how: "swipe" | "tap", until: string) => void;
  onPickAction: (item: AttentionItem, action: CardActionKind) => void;
}) {
  return (
    <>
      {asking && (
        <ReturnTimeSheet
          title={asking.item.title ?? asking.item.id}
          onClose={() => setAsking(null)}
          onPick={(until) => {
            onCommitLater(asking.item, asking.how, until);
            setAsking(null);
          }}
        />
      )}
      {pickingLane && flow && <LaneSheet flow={flow} items={items} onClose={() => setPickingLane(false)} />}
      {current && menuFor === currentId && (
        <CardActionsSheet
          item={current}
          title={current.title ?? current.id}
          actions={cardActions(current, { typed, sending, always: !!current.pendingApproval && offersAlways(current.pendingApproval), handoff: !!handoff })}
          onPick={(action) => onPickAction(current, action)}
          onClose={() => setMenuFor(null)}
        />
      )}
      {handingOff && handoff && (
        <Sheet label="Hand Off" onClose={() => setHandingOff(null)} placement="bottom" className="loki-phone-sheet">
          <HandoffPicker item={handingOff} source={handoff} touch onCancel={() => setHandingOff(null)} onDone={() => setHandingOff(null)} />
        </Sheet>
      )}
      {labelling && (
        <MailLabelsSheet load={() => moves.labelsOf(labelling)} onAdd={(ids) => moves.label(labelling, ids, "tap")} onClose={() => setLabelling(null)} />
      )}
    </>
  );
}

export function Flow({
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
  moves: FlowMoves;
  onNote: (text: string) => void;
  card: CardActions;
}) {
  const reduced = useReducedMotion();
  const { visible, current, currentId } = deck;
  const { deckRef, width } = useDeckWidth(!!current);
  const flow = chats.flow;
  const lane = flow?.lane ?? null;
  const laneCards = flow?.laneItems ?? items;
  const others = otherLanesLine(otherLanesCount(items, lane));
  const [pickingLane, setPickingLane] = useState(false);

  const running = laneCards.filter((i) => i.status === "running").length;
  const needYou = catchUpQueue(laneCards).length;
  const { typed, sending, typedId, setTypedId, setSendingId } = useFlowInputState(current, currentId, chats);
  const { asking, setAsking, labelling, setLabelling, handingOff, setHandingOff, menuFor, setMenuFor } = useFlowModals(currentId);
  const { hint, leaving, undo, refused, said, commit, undoLast, pick, swipe } = useFlowGestures({
    deck,
    reduced,
    moves,
    onNote,
    onApprove,
    current,
    width,
    typed,
    sending,
    typedId,
    setTypedId,
    setAsking,
    setMenuFor,
    setLabelling,
    setHandingOff,
  });
  const handoff = chats.handoffPropose && chats.handoff ? { handoffPropose: chats.handoffPropose, handoff: chats.handoff } : null;

  useFlowShown(current, currentId, hidden, onShown);
  const rootRef = useRef<HTMLDivElement>(null);
  useFlowFocus(rootRef, !!current, hidden);

  const backButton = current ? (
    <button type="button" className="loki-phone-icon-btn" aria-label={`Back to ${backLabel}`} onClick={onClose}>
      <Icon name="back" size={22} />
    </button>
  ) : undefined;

  return (
    <div ref={rootRef} className="loki-phone-flow loki-phone-above-nav" data-away={hidden || undefined} aria-hidden={hidden || undefined}>
      <TopBar
        left={backButton}
        inline
        title={flow ? <LaneTitle lane={lane} onOpen={() => setPickingLane(true)} /> : "Flow"}
        sub={flowSubtitle(!!current, needYou, visible.length, others)}
        right={undo ? <UndoButton key={idOf(undo.item)} via={undo.via} onUndo={undoLast} /> : undefined}
        banner={current ? undefined : banner}
      />
      <div className="loki-phone-sr-only" role="status" aria-live="polite">
        {said}
      </div>

      <FlowMain
        current={current}
        available={available}
        loaded={loaded}
        banner={banner}
        running={running}
        needYou={needYou}
        deck={deck}
        laneCards={laneCards}
        others={others}
        lane={lane}
        flow={flow}
        backLabel={backLabel}
        onClose={onClose}
        onConnection={onConnection}
        deckRef={deckRef}
        drag={swipe.drag}
        release={swipe.release}
        handlers={swipe.handlers}
        leaving={leaving}
        refused={refused}
        width={width}
        typed={typed}
        sending={sending}
        visible={visible}
        reduced={reduced}
        chats={chats}
        card={card}
        onOpen={onOpen}
        labelList={labelList}
        items={items}
        hint={hint}
        onMore={() => setMenuFor(currentId)}
        onTyped={(item, has) => setTypedId(has ? idOf(item) : typedId === idOf(item) ? null : typedId)}
        onSending={(item, on) => setSendingId((t) => (on ? idOf(item) : t === idOf(item) ? null : t))}
      />
      <FlowSheets
        current={current}
        currentId={currentId}
        items={items}
        flow={flow}
        handoff={handoff}
        moves={moves}
        typed={typed}
        sending={sending}
        pickingLane={pickingLane}
        setPickingLane={setPickingLane}
        asking={asking}
        setAsking={setAsking}
        menuFor={menuFor}
        setMenuFor={setMenuFor}
        handingOff={handingOff}
        setHandingOff={setHandingOff}
        labelling={labelling}
        setLabelling={setLabelling}
        onCommitLater={(item, how, until) => commit(item, "later", how, { until })}
        onPickAction={pick}
      />
    </div>
  );
}
