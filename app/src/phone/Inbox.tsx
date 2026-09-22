import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import { catchUpQueue, idOf, snoozedItems } from "../../../core/attention/queue.ts";
import { formatIn } from "../../../core/attention/snooze.ts";
import { REASON_LABEL } from "../../../core/attention/priority.ts";
import { formatInput } from "../../../core/attention/format.ts";
import { ApprovalCard } from "../chat/ApprovalCard";
import type { TranscriptRow } from "../chat/Transcript";
import { AgentChip, AgentFace } from "../desk/AgentChip";
import { avatarUrl } from "../desk/env";
import { BADGE } from "../desk/CatchUp";
import { Thread } from "../chat/Conversation";
import { waitingSince } from "./model";
import { Button, Chip, Empty, Meta, Row } from "../components";
import { SAFE, TopBar } from "./ui";
import {
  DRAG_SLOP,
  EMPTY_PASS,
  FLY_EASE,
  FLY_MS,
  UNDO_MS,
  cardsToDraw,
  dismiss,
  isHorizontalDrag,
  passTotal,
  pruneDismissed,
  refusedOffset,
  restore,
  revealOpacity,
  rotationFor,
  stackPose,
  summaryLine,
  swipeDecision,
  tally,
  toFront,
  velocityOf,
  visibleQueue,
  type Dismissed,
  type PassSummary,
  type Role,
  type Swipe,
  type Via,
} from "./deck";

/**
 * The inbox as a deck, the way Slack's Catch Up works on a phone: one card at a time, full width,
 * the next one or two peeking from behind. Swipe right for seen, left for later; tap to open;
 * buttons under the deck do the same for thumbs that do not swipe. Approvals refuse both swipes —
 * approve or deny inside the card is the only way off. An undo pill follows each swipe for six
 * seconds. The pure parts (when a drag commits, the lean, the pass tally, what stays hidden) are
 * in deck.ts.
 */

/** The two or three lines a card would show under its title without a thread (kept for callers). */
export function preview(item: AttentionItem): string {
  if (item.pendingApproval) return `run ${item.pendingApproval.toolName}\n${formatInput(item.pendingApproval.input)}`;
  if (item.pendingQuestion) return item.pendingQuestion.questions.map((q) => q.question).join("\n");
  if (item.status === "failed" && item.error) return item.error;
  return item.lastAssistantText ?? "";
}

/** What the deck needs of a conversation to draw the thread inside a card. */
export interface CardView {
  rows: TranscriptRow[] | undefined;
  status: "idle" | "thinking" | "streaming";
}

/** Space under the top card where the stack shows through: two hints, six pixels each. */
const PEEK = 12;

/**
 * What a pass remembers: the cards swiped (until the seen marker or the snooze lands) and the one on
 * top, kept there while the list re-sorts beneath. The parent holds it — it also owns the transcripts,
 * and fetches the top card's when it changes — and hands it to the Inbox, which swipes.
 */
export interface Deck {
  /** The queue minus the dismissed, the pinned card first. */
  visible: AttentionItem[];
  current: AttentionItem | undefined;
  currentId: string | null;
  /** A card swiped off: hidden until its marker lands; the next one comes up. */
  dismiss: (item: AttentionItem) => void;
  /** The swipe taken back: the card returns on top. */
  restore: (item: AttentionItem) => void;
}

export function useDeck(items: AttentionItem[]): Deck {
  const [dismissed, setDismissed] = useState<Dismissed>(() => new Map());
  /** The card on top stays on top while the list re-sorts under it. */
  const [topId, setTopId] = useState<string | null>(null);
  const queue = useMemo(() => catchUpQueue(items), [items]);
  const visible = useMemo(() => toFront(visibleQueue(queue, dismissed), topId), [queue, dismissed, topId]);
  const current: AttentionItem | undefined = visible[0];
  const currentId = current ? idOf(current) : null;

  // Pin whatever is on top; drop dismissals the live list has outgrown.
  useEffect(() => {
    if (currentId !== topId) setTopId(currentId);
  }, [currentId, topId]);
  useEffect(() => {
    setDismissed((d) => {
      const next = pruneDismissed(d, items);
      return next.size === d.size ? d : next;
    });
  }, [items]);

  return {
    visible,
    current,
    currentId,
    dismiss: (item) => {
      setDismissed((d) => dismiss(d, item));
      setTopId(null);
    },
    restore: (item) => {
      setDismissed((d) => restore(d, item));
      setTopId(idOf(item));
    },
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
function useDeckWidth(hidden: boolean) {
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
  }, [hidden]);
  return { deckRef, width };
}

/**
 * What a pass does to the deck as cards go: the tally; the card flying off (for FLY_MS, unless motion
 * is reduced); the undo pill's card (for UNDO_MS after a seen or later); the flash when an approval
 * refuses a swipe. `commit` takes the card off by one of the four ways and tells the parent; `undoLast`
 * puts the last swipe back.
 */
function usePass({ deck, reduced, onSeen, onLater, onUndo, onCommit }: { deck: Deck; reduced: boolean; onSeen: (item: AttentionItem) => void; onLater: (item: AttentionItem) => void; onUndo: (item: AttentionItem, via: Swipe) => void; onCommit: () => void }) {
  const [pass, setPass] = useState<PassSummary>(EMPTY_PASS);
  const [leaving, setLeaving] = useState<{ item: AttentionItem; dir: 1 | -1 } | null>(null);
  const [undo, setUndo] = useState<{ item: AttentionItem; via: Swipe } | null>(null);
  const [refused, setRefused] = useState(false);
  const undoTimer = useTimer();
  const leaveTimer = useTimer();
  const refuseTimer = useTimer();

  const commit = (item: AttentionItem, via: Via) => {
    deck.dismiss(item);
    setPass((p) => tally(p, via));
    onCommit();
    if (via === "seen") onSeen(item);
    else if (via === "later") onLater(item);
    if (!reduced) {
      setLeaving({ item, dir: via === "later" || via === "deny" ? -1 : 1 });
      leaveTimer.set(() => setLeaving((l) => (l && idOf(l.item) === idOf(item) ? null : l)), FLY_MS + 30);
    }
    undoTimer.clear();
    if (via === "seen" || via === "later") {
      setUndo({ item, via });
      undoTimer.set(() => setUndo(null), UNDO_MS);
    } else setUndo(null);
  };
  const undoLast = () => {
    if (!undo) return;
    undoTimer.clear();
    deck.restore(undo.item);
    setPass((p) => tally(p, undo.via, -1));
    setLeaving(null);
    onUndo(undo.item, undo.via);
    setUndo(null);
  };
  const flashRefused = () => {
    setRefused(true);
    refuseTimer.set(() => setRefused(false), 420);
  };
  return { pass, leaving, undo, refused, commit, undoLast, flashRefused };
}

/**
 * Pointer Events on the top card (touch and mouse alike). A drag starts only once the finger has
 * moved more sideways than up and past the slop, so the thread inside still scrolls; touch-action
 * pan-y hands vertical pans to the browser, which then cancels our pointer. Owns the drag offset and
 * the velocity samples; the tap that ends a drag does not open the card.
 */
function useSwipe({ width, approval, current, onCommit, onRefuse, onOpen }: { width: number; approval: boolean; current: AttentionItem | undefined; onCommit: (item: AttentionItem, via: Swipe) => void; onRefuse: () => void; onOpen: (item: AttentionItem) => void }) {
  const [drag, setDrag] = useState<{ dx: number } | null>(null);
  const start = useRef<{ x: number; y: number; id: number; dragging: boolean; samples: { x: number; t: number }[] } | null>(null);
  const suppressClick = useRef(false);
  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
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
    suppressClick.current = true;
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
  const onClick = (e: React.MouseEvent<HTMLElement>) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if ((e.target as HTMLElement).closest("button, a, input, textarea, select, summary, pre")) return;
    if (current) onOpen(current);
  };
  const handlers: CardHandlers = { onPointerDown, onPointerMove, onPointerUp: (e) => finish(e, false), onPointerCancel: (e) => finish(e, true), onClick };
  return { drag, clear: () => setDrag(null), handlers };
}

export function Inbox({
  items,
  loaded,
  available,
  hidden = false,
  banner,
  conversation,
  deck,
  onOpen,
  onApprove,
  onSeen,
  onLater,
  onUnsnooze,
  onUndo,
}: {
  items: AttentionItem[];
  /** The app-server has answered at least once; before that an empty list means nothing. */
  loaded: boolean;
  /** The mod found an app-server to tunnel to; without one there is no inbox to read. */
  available: boolean;
  /** A conversation is open on top: keep the pass (counts, dismissed cards) but draw nothing. */
  hidden?: boolean;
  /** "Mac unreachable": the only place the link state shows here; the header is one row. */
  banner?: ReactNode;
  /** The live thread behind a card; `rows` is undefined until loaded. */
  conversation: (agentId: string, conversationId: string) => CardView;
  /** The pass, from `useDeck` in the parent. */
  deck: Deck;
  onOpen: (item: AttentionItem) => void;
  onApprove: (item: AttentionItem, requestId: string, behavior: "allow" | "deny") => void;
  onSeen: (item: AttentionItem) => void;
  onLater: (item: AttentionItem) => void;
  onUnsnooze: (item: AttentionItem) => void;
  /** Take back the last swipe: "seen" → unmark seen, "later" → clear the snooze. */
  onUndo: (item: AttentionItem, via: Swipe) => void;
}) {
  const reduced = useReducedMotion();
  const [showDeferred, setShowDeferred] = useState(false);
  const { deckRef, width } = useDeckWidth(hidden);

  const snoozed = snoozedItems(items);
  const running = items.filter((i) => i.status === "running").length;
  const { visible, current } = deck;
  const approval = !!current?.pendingApproval;

  const { pass, leaving, undo, refused, commit, undoLast, flashRefused } = usePass({ deck, reduced, onSeen, onLater, onUndo, onCommit: () => swipe.clear() });
  const swipe = useSwipe({ width, approval, current, onCommit: commit, onRefuse: flashRefused, onOpen });

  const total = passTotal(pass) + visible.length;
  const progress = total > 0 ? passTotal(pass) / total : 0;

  return (
    // A tab with a fixed bottom (the thumb buttons): it stops above the floating navigation rather than under it.
    <div className="loki-phone-above-nav" style={{ flex: 1, minHeight: 0, display: hidden ? "none" : "flex", flexDirection: "column", position: "relative" }}>
      <TopBar
        title="Inbox"
        height={44}
        right={
          total > 0 ? (
            <Meta aria-live="polite">
              {visible.length} left
            </Meta>
          ) : null
        }
        progress={progress}
      />
      {banner}

      {!current ? (
        <EmptyDeck available={available} loaded={loaded} running={running} pass={pass} snoozed={snoozed} showDeferred={showDeferred} onToggleDeferred={() => setShowDeferred((v) => !v)} onOpen={onOpen} onUnsnooze={onUnsnooze} />
      ) : (
        <div ref={deckRef} style={{ flex: 1, minHeight: 0, position: "relative", margin: `8px calc(10px + ${SAFE.right}) 8px calc(10px + ${SAFE.left})` }}>
          <Reveal dx={swipe.drag?.dx ?? 0} width={width} approval={approval} />
          <Stack
            visible={visible}
            leaving={leaving}
            drag={swipe.drag}
            width={width}
            approval={approval}
            refused={refused}
            reduced={reduced}
            conversation={conversation}
            handlers={swipe.handlers}
            onOpen={onOpen}
          />
        </div>
      )}

      {current && (
        <ThumbActionRow
          item={current}
          onLater={() => commit(current, "later")}
          onSeen={() => commit(current, "seen")}
          onApprove={(behavior) => {
            if (!current.pendingApproval) return;
            onApprove(current, current.pendingApproval.requestId, behavior);
            commit(current, behavior === "allow" ? "approve" : "deny");
          }}
        />
      )}

      {undo && <UndoPill via={undo.via} onUndo={undoLast} />}
    </div>
  );
}

/** Nothing on the deck: why (no harness, still reading, caught up), the pass so far, and the deferred cards behind a toggle. */
function EmptyDeck({ available, loaded, running, pass, snoozed, showDeferred, onToggleDeferred, onOpen, onUnsnooze }: { available: boolean; loaded: boolean; running: number; pass: PassSummary; snoozed: AttentionItem[]; showDeferred: boolean; onToggleDeferred: () => void; onOpen: (item: AttentionItem) => void; onUnsnooze: (item: AttentionItem) => void }) {
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overscrollBehavior: "contain", WebkitOverflowScrolling: "touch", padding: `12px calc(12px + ${SAFE.right}) 24px calc(12px + ${SAFE.left})`, display: "grid", gap: 10, alignContent: "start" }}>
      <Empty card title={!available ? "No harness on the Mac." : loaded ? "You're caught up." : "Reading the inbox…"} style={{ marginTop: 24 }}>
        {passTotal(pass) > 0 && <div style={{ fontSize: 10.5, color: "var(--loki-fg)", marginTop: 10, fontFamily: "var(--loki-mono)", letterSpacing: "0.06em" }}>{summaryLine(pass)}</div>}
        <div style={{ fontSize: 12, color: "var(--loki-muted)", marginTop: 8 }}>{!available ? "loki's mod has not found Letta's app-server; open loki on the Mac" : !loaded ? "the Mac is listing conversations" : running > 0 ? `${running} still running` : "nothing is waiting on you"}</div>
        {snoozed.length > 0 && (
          <Button size="touch" onClick={onToggleDeferred} aria-expanded={showDeferred} style={{ marginTop: 16 }}>
            deferred · {snoozed.length}
          </Button>
        )}
      </Empty>
      {showDeferred && <DeferredList snoozed={snoozed} onOpen={onOpen} onUnsnooze={onUnsnooze} />}
    </div>
  );
}

/** The snoozed cards as rows: title, agent and when each comes back, with unsnooze beside. */
function DeferredList({ snoozed, onOpen, onUnsnooze }: { snoozed: AttentionItem[]; onOpen: (item: AttentionItem) => void; onUnsnooze: (item: AttentionItem) => void }) {
  return snoozed.map((item) => (
    <div key={idOf(item)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 8px 4px 0", border: "1px solid var(--loki-border)", borderRadius: 8, opacity: 0.75 }}>
      <Row touch onClick={() => onOpen(item)} style={{ flex: 1, minWidth: 0, fontSize: 13.5 }}>
        <span style={{ flex: 1, minWidth: 0, display: "grid", gap: 2 }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.title ?? item.id}</span>
          <Meta>
            {item.agentName ?? "agent"} · back in {item.snooze ? formatIn(item.snooze.until) : "a while"}
          </Meta>
        </span>
      </Row>
      <Button size="touch" onClick={() => onUnsnooze(item)}>
        unsnooze
      </Button>
    </div>
  ));
}

/** The reveal, between the stack and the top card: seen on the left as the card goes right, later on the right. Approvals reveal nothing. */
function Reveal({ dx, width, approval }: { dx: number; width: number; approval: boolean }) {
  const seenReveal = !approval && dx > 0 ? revealOpacity(dx, width) : 0;
  const laterReveal = !approval && dx < 0 ? revealOpacity(dx, width) : 0;
  return (
    <div aria-hidden style={{ position: "absolute", inset: `0 0 ${PEEK}px`, zIndex: 5, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 26px", pointerEvents: "none" }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--loki-positive)", fontFamily: "var(--loki-mono)", fontSize: 15, letterSpacing: "0.06em", opacity: seenReveal, transform: `scale(${0.9 + seenReveal * 0.1})` }}>
        <Check /> seen
      </span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--loki-muted)", fontFamily: "var(--loki-mono)", fontSize: 15, letterSpacing: "0.06em", opacity: laterReveal, transform: `scale(${0.9 + laterReveal * 0.1})` }}>
        later <Clock />
      </span>
    </div>
  );
}

/** One keyed list, one component: a card keeps its DOM node as it goes shell → top → leaving, so its transform transitions between poses. */
function Stack({ visible, leaving, drag, width, approval, refused, reduced, conversation, handlers, onOpen }: { visible: AttentionItem[]; leaving: { item: AttentionItem; dir: 1 | -1 } | null; drag: { dx: number } | null; width: number; approval: boolean; refused: boolean; reduced: boolean; conversation: (agentId: string, conversationId: string) => CardView; handlers: CardHandlers; onOpen: (item: AttentionItem) => void }) {
  const dx = drag?.dx ?? 0;
  const move = reduced ? "none" : `transform ${FLY_MS}ms ${FLY_EASE}, opacity ${FLY_MS}ms ${FLY_EASE}`;
  return cardsToDraw(visible, leaving?.item ?? null).map(({ item, role, index }) => {
    if (role === "leaving")
      return <Card key={idOf(item)} item={item} role={role} view={conversation(item.agentId, item.id)} style={{ zIndex: 7, transform: `translateX(${leaving!.dir * (width + 80)}px) rotate(${leaving!.dir * 12}deg)`, opacity: 0, transition: move, pointerEvents: "none" }} />;
    if (role === "top") {
      const offset = approval ? refusedOffset(dx) : dx;
      return (
        <Card
          key={idOf(item)}
          item={item}
          role={role}
          view={conversation(item.agentId, item.id)}
          refused={refused}
          style={{
            zIndex: 6,
            transform: drag ? `translateX(${offset}px) rotate(${rotationFor(offset, width)}deg)` : "none",
            transition: drag ? "none" : move,
          }}
          handlers={handlers}
          onOpen={() => onOpen(item)}
        />
      );
    }
    const pose = stackPose(index);
    return <Card key={idOf(item)} item={item} role={role} veil={1 - pose.opacity} style={{ zIndex: 4 - index, transform: `translateY(${pose.offsetY}px) scale(${pose.scale})`, transition: move, pointerEvents: "none" }} />;
  });
}

/** The pill under the deck after a swipe: one tap puts the card back. */
function UndoPill({ via, onUndo }: { via: Swipe; onUndo: () => void }) {
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 64, display: "flex", justifyContent: "center", zIndex: 8, pointerEvents: "none" }}>
      <Button size="touch" tone="brass" onClick={onUndo} className="loki-sheet" style={{ pointerEvents: "auto", background: "var(--loki-panel)", borderRadius: 999, padding: "0 18px", boxShadow: "var(--loki-shadow-low)" }}>
        undo {via === "seen" ? "seen" : "later"}
      </Button>
    </div>
  );
}

/** One card's frame: panel, hairline (brass for a decision), the card radius. */
function frame(item: AttentionItem, extra: CSSProperties): CSSProperties {
  const badge = BADGE[item.status];
  return {
    position: "absolute",
    inset: `0 0 ${PEEK}px`,
    display: "flex",
    flexDirection: "column",
    background: "var(--loki-panel)",
    border: `1px solid ${item.status === "approval" || item.status === "question" ? badge.color : "var(--loki-border)"}`,
    borderRadius: 12,
    overflow: "hidden",
    transformOrigin: "50% 100%",
    willChange: "transform",
    ...extra,
  };
}

function Head({ item }: { item: AttentionItem }) {
  const badge = BADGE[item.status];
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, padding: "10px 12px 0" }}>
        <AgentFace name={item.agentName} src={avatarUrl(item.agentId)} size={20} />
        <AgentChip name={item.agentName} />
        <span style={{ flex: 1 }} />
        <Chip tone={badge.color}>{badge.label}</Chip>
      </div>
      <div style={{ fontFamily: "var(--loki-display)", fontSize: 15, color: "var(--loki-fg)", margin: "6px 12px 0", paddingBottom: 8, borderBottom: "1px solid var(--loki-border)", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", overflowWrap: "anywhere" }}>{item.title ?? item.id}</div>
    </>
  );
}

interface CardHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
  onClick: (e: React.MouseEvent<HTMLElement>) => void;
}

function Card({
  item,
  role,
  view,
  refused = false,
  veil = 0,
  style,
  handlers,
  onOpen,
}: {
  item: AttentionItem;
  role: Role;
  view?: CardView;
  refused?: boolean;
  /** 0..1: how much of the veil sits over a card behind the top one. */
  veil?: number;
  style: CSSProperties;
  handlers?: CardHandlers;
  onOpen?: () => void;
}) {
  const badge = BADGE[item.status];
  const top = role === "top";
  return (
    <article
      aria-label={`${item.title ?? item.id}, ${badge.label}`}
      aria-hidden={!top}
      {...(top ? handlers : {})}
      style={frame(item, { ...style, touchAction: "pan-y", userSelect: "none", WebkitUserSelect: "none", WebkitTapHighlightColor: "transparent", cursor: top ? "grab" : "default", outline: refused ? "2px solid var(--loki-accent)" : "none", outlineOffset: -1 })}
    >
      <Head item={item} />
      {role === "shell" ? <div style={{ flex: 1 }} /> : <CardBody item={item} view={view} onOpen={onOpen} />}
      {/* Cards behind the top one are dimmed by an opaque veil, not opacity, so the stack does not show through itself. */}
      {veil > 0 && <div aria-hidden style={{ position: "absolute", inset: 0, background: "var(--loki-veil)", opacity: veil, pointerEvents: "none" }} />}
    </article>
  );
}

/** A live card below its head: the thread, the approval's details, and the footer row. Shells draw none of it. */
function CardBody({ item, view, onOpen }: { item: AttentionItem; view?: CardView; onOpen?: () => void }) {
  return (
    <>
      {/* The thread spans the card: the phone's column is the reading measure (PhoneStyles lifts the desktop's 78% cap). */}
      {view && (
        <div className="loki-phone-thread" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <Thread rows={view.rows} status={view.status} error={item.status === "failed" ? item.error : null} agentName={item.agentName} style={{ padding: "8px 12px" }} />
        </div>
      )}
      {item.pendingApproval && <ApprovalCard approval={item.pendingApproval} />}
      <CardFooter item={item} onOpen={onOpen} />
    </>
  );
}

/** One footer row: when, then what you can do about it. Approvals decide here; questions answer in the thread. */
function CardFooter({ item, onOpen }: { item: AttentionItem; onOpen?: () => void }) {
  /** The one word that explains the card's place in the queue; blocked cards say it with the badge. */
  const reason = REASON_LABEL[item.reason];
  return (
    <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 6, minHeight: 40, padding: "4px 8px 4px 12px", borderTop: "1px solid var(--loki-border)" }}>
      <Meta style={{ flex: 1, minWidth: 0 }}>
        {reason && `${reason} · `}
        {waitingSince(item)}
      </Meta>
      <Button size="touch" bare onClick={onOpen} aria-label="open conversation">
        open
      </Button>
    </div>
  );
}

/** Persistent thumb controls below the card; every swipe has a visible button equivalent. */
function ThumbActionRow({ item, onLater, onSeen, onApprove }: { item: AttentionItem; onLater: () => void; onSeen: () => void; onApprove: (behavior: "allow" | "deny") => void }) {
  return (
    <div style={{ flex: "0 0 auto", display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8, padding: `8px calc(12px + ${SAFE.right}) 10px calc(12px + ${SAFE.left})`, borderTop: "1px solid var(--loki-border)", background: "var(--loki-panel)" }}>
      {item.pendingApproval ? (
        <>
          <Button size="touch" tone="negative" block onClick={() => onApprove("deny")}>
            deny
          </Button>
          <Button size="touch" tone="positive" block onClick={() => onApprove("allow")}>
            approve
          </Button>
        </>
      ) : (
        <>
          <Button size="touch" tone="paper" block onClick={onLater} title="comes back later, later each time">
            <Clock /> later
          </Button>
          <Button size="touch" tone="positive" block onClick={onSeen}>
            <Check /> seen
          </Button>
        </>
      )}
    </div>
  );
}

function Check() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 10.5 8.2 14.5 16 6" />
    </svg>
  );
}

function Clock() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6v4.4l2.8 1.8" />
    </svg>
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
