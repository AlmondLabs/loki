import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
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
import { takeSeeds, useDeckWidth, usePass, useReducedMotion, useSwipe, type CardActions, type Deck, type FlowMoves, type SeedsTaken } from "./use-flow-deck";

export { Card, CardConversation, dragWords } from "./flow-card";
export { takeSeeds, useDeck, type CardActions, type CardModel, type CardView, type Deck, type FlowMoves, type SeedsTaken } from "./use-flow-deck";

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
  const { visible, current } = deck;
  const { deckRef, width } = useDeckWidth(!!current);
  const flow = chats.flow;
  const lane = flow?.lane ?? null;
  const laneCards = flow?.laneItems ?? items;
  const others = otherLanesLine(otherLanesCount(items, lane));
  const [pickingLane, setPickingLane] = useState(false);

  const running = laneCards.filter((i) => i.status === "running").length;
  const currentId = current ? idOf(current) : null;
  const [typedId, setTypedId] = useState<string | null>(null);
  const [keptReply] = useOutsideReply(current?.outside ? currentId : null);
  const [chatDraft] = useDraft(current && !current.outside ? draftKey(current.agent_id, current.id) : null);
  const typedHere = !!currentId && (typedId === currentId || !!keptReply.trim());
  const typed = typedHere || (!!currentId && (!!chatDraft.text.trim() || chatDraft.images.length > 0));
  useReplyHold(typedHere);
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
  const [handingOff, setHandingOff] = useState<AttentionItem | null>(null);
  const hint = useFlowHint(current);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  if (menuFor && menuFor !== currentId) setMenuFor(null);
  const handoff = chats.handoffPropose && chats.handoff ? { handoffPropose: chats.handoffPropose, handoff: chats.handoff } : null;

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
  const later = (item: AttentionItem, how: "swipe" | "tap") => {
    if (!item.pendingApproval && moves.laterAsks(item)) {
      swipe.clear();
      setAsking({ item, how });
    } else commit(item, "later", how);
  };
  const decide = (item: AttentionItem, behavior: "allow" | "deny" | "always", how: "swipe" | "tap") => {
    if (!item.pendingApproval) return;
    onApprove(item, item.pendingApproval.requestId, behavior);
    commit(item, behavior === "deny" ? "deny" : "approve", how);
  };
  const act = (item: AttentionItem, via: Via, how: "swipe" | "tap") => {
    if (via === "later") later(item, how);
    else if (via === "approve" || via === "deny") decide(item, via === "approve" ? "allow" : "deny", how);
    else commit(item, via, how);
  };
  const pick = (item: AttentionItem, action: CardActionKind) => {
    setMenuFor(null);
    if (action === "label") setLabelling(item);
    else if (action === "handoff") setHandingOff(item);
    else if (action === "always") decide(item, "always", "tap");
    else if (action === "later" && item.pendingApproval) commit(item, "later", "tap", { from: "menu" });
    else act(item, action, "tap");
  };
  const swipe = useSwipe({
    width,
    typed,
    sending,
    current,
    onCommit: (item, via) => act(item, via, "swipe"),
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
    <div ref={rootRef} className="loki-phone-flow loki-phone-above-nav" data-away={hidden || undefined} aria-hidden={hidden || undefined}>
      <TopBar
        left={
          current ? (
            <button type="button" className="loki-phone-icon-btn" aria-label={`Back to ${backLabel}`} onClick={onClose}>
              <Icon name="back" size={22} />
            </button>
          ) : undefined
        }
        inline
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
            <Reveal drag={swipe.drag} width={width} item={current} typed={typed} sending={sending} />
            <Stack
              onTyped={(item, has) => setTypedId((t) => (has ? idOf(item) : t === idOf(item) ? null : t))}
              onSending={(item, on) => setSendingId((t) => (on ? idOf(item) : t === idOf(item) ? null : t))}
              visible={visible}
              leaving={leaving}
              drag={swipe.drag}
              release={swipe.release}
              width={width}
              refused={refused}
              onMore={() => setMenuFor(currentId)}
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
            {hint.shown && <FlowHint words={`Drag the reply box. ${dragWords(current)}`} onDismiss={hint.dismiss} />}
          </div>
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
      {current && menuFor === currentId && (
        <CardActionsSheet
          item={current}
          title={current.title ?? current.id}
          actions={cardActions(current, { typed, sending, always: !!current.pendingApproval && offersAlways(current.pendingApproval), handoff: !!handoff })}
          onPick={(action) => pick(current, action)}
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
    </div>
  );
}
