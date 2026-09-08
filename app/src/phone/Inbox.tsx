import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { AttentionItem } from "../../../packages/core/src/attention/model.ts";
import { catchUpQueue, idOf, snoozedItems } from "../../../packages/core/src/attention/queue.ts";
import { formatIn } from "../../../packages/core/src/attention/snooze.ts";
import { formatInput } from "../../../packages/core/src/attention/format.ts";
import { ApprovalCard } from "../chat/ApprovalCard";
import type { TranscriptRow } from "../chat/Transcript";
import { AgentChip, AgentFace } from "../desk/AgentChip";
import { avatarUrl } from "../desk/env";
import { BADGE, CardThread } from "../desk/CatchUp";
import { lastSeen } from "./model";
import { Button, Chip, Empty, Meta, Row } from "../ui";
import { SAFE, TopBar } from "./ui";
import {
  DRAG_SLOP,
  EMPTY_PASS,
  FLY_EASE,
  FLY_MS,
  UNDO_MS,
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

export function Inbox({
  items,
  loaded,
  available,
  hidden = false,
  banner,
  conversation,
  onLoad,
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
  /** Fetch a card's transcript once it is on top. */
  onLoad: (item: AttentionItem) => void;
  onOpen: (item: AttentionItem) => void;
  onApprove: (item: AttentionItem, requestId: string, behavior: "allow" | "deny") => void;
  onSeen: (item: AttentionItem) => void;
  onLater: (item: AttentionItem) => void;
  onUnsnooze: (item: AttentionItem) => void;
  /** Take back the last swipe: "seen" → unmark seen, "later" → clear the snooze. */
  onUndo: (item: AttentionItem, via: Swipe) => void;
}) {
  const reduced = useReducedMotion();
  const [dismissed, setDismissed] = useState<Dismissed>(() => new Map());
  const [pass, setPass] = useState<PassSummary>(EMPTY_PASS);
  /** The card on top stays on top while the list re-sorts under it. */
  const [topId, setTopId] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ dx: number } | null>(null);
  const [leaving, setLeaving] = useState<{ item: AttentionItem; dir: 1 | -1 } | null>(null);
  const [undo, setUndo] = useState<{ item: AttentionItem; via: Swipe } | null>(null);
  const [refused, setRefused] = useState(false);
  const [showDeferred, setShowDeferred] = useState(false);
  const [width, setWidth] = useState(360);
  const deckRef = useRef<HTMLDivElement>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refuseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const queue = useMemo(() => catchUpQueue(items), [items]);
  const snoozed = snoozedItems(items);
  const running = items.filter((i) => i.status === "running").length;
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

  // The top card's thread, fetched once when it arrives; live rows stream in on top.
  useEffect(() => {
    if (current) onLoad(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId]);

  // The card's width decides the commit distance and the lean.
  useEffect(() => {
    const el = deckRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth || 360);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hidden]);

  useEffect(
    () => () => {
      for (const t of [undoTimer, leaveTimer, refuseTimer]) if (t.current) clearTimeout(t.current);
    },
    [],
  );

  const commit = (item: AttentionItem, via: Via) => {
    setDismissed((d) => dismiss(d, item));
    setPass((p) => tally(p, via));
    setTopId(null);
    setDrag(null);
    if (via === "seen") onSeen(item);
    else if (via === "later") onLater(item);
    if (!reduced) {
      if (leaveTimer.current) clearTimeout(leaveTimer.current);
      setLeaving({ item, dir: via === "later" || via === "deny" ? -1 : 1 });
      leaveTimer.current = setTimeout(() => setLeaving((l) => (l && idOf(l.item) === idOf(item) ? null : l)), FLY_MS + 30);
    }
    if (undoTimer.current) clearTimeout(undoTimer.current);
    if (via === "seen" || via === "later") {
      setUndo({ item, via });
      undoTimer.current = setTimeout(() => setUndo(null), UNDO_MS);
    } else setUndo(null);
  };
  const undoLast = () => {
    if (!undo) return;
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setDismissed((d) => restore(d, undo.item));
    setPass((p) => tally(p, undo.via, -1));
    setTopId(idOf(undo.item));
    setLeaving(null);
    onUndo(undo.item, undo.via);
    setUndo(null);
  };
  const flashRefused = () => {
    setRefused(true);
    if (refuseTimer.current) clearTimeout(refuseTimer.current);
    refuseTimer.current = setTimeout(() => setRefused(false), 420);
  };

  // Pointer Events on the top card (touch and mouse alike). A drag starts only once the finger has
  // moved more sideways than up and past the slop, so the thread inside still scrolls; touch-action
  // pan-y hands vertical pans to the browser, which then cancels our pointer.
  const start = useRef<{ x: number; y: number; id: number; dragging: boolean; samples: { x: number; t: number }[] } | null>(null);
  const suppressClick = useRef(false);
  const approval = !!current?.pendingApproval;
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
    if (decision) commit(current, decision);
    else {
      setDrag(null);
      if (approval && Math.abs(dx) > DRAG_SLOP * 2) flashRefused();
    }
  };
  const onCardClick = (e: React.MouseEvent<HTMLElement>) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if ((e.target as HTMLElement).closest("button, a, input, textarea, select, summary, pre")) return;
    if (current) onOpen(current);
  };

  const total = passTotal(pass) + visible.length;
  const position = current ? passTotal(pass) + 1 : total;
  const progress = total > 0 ? passTotal(pass) / total : 0;
  const dx = drag?.dx ?? 0;
  const seenReveal = !approval && dx > 0 ? revealOpacity(dx, width) : 0;
  const laterReveal = !approval && dx < 0 ? revealOpacity(dx, width) : 0;
  const move = reduced ? "none" : `transform ${FLY_MS}ms ${FLY_EASE}, opacity ${FLY_MS}ms ${FLY_EASE}`;

  /** The cards drawn: the one flying off (if any) over the top three of the stack. */
  const cards: { item: AttentionItem; role: Role; index: number }[] = [
    ...(leaving ? [{ item: leaving.item, role: "leaving" as Role, index: -1 }] : []),
    ...visible
      .slice(0, 3)
      .filter((i) => !leaving || idOf(i) !== idOf(leaving.item))
      .map((item, index) => ({ item, role: (index === 0 ? "top" : "shell") as Role, index })),
  ];

  return (
    <div style={{ flex: 1, minHeight: 0, display: hidden ? "none" : "flex", flexDirection: "column", position: "relative" }}>
      <TopBar
        title="Catch Up"
        height={44}
        right={
          total > 0 ? (
            <Meta aria-live="polite">
              {position} of {total}
            </Meta>
          ) : null
        }
        progress={progress}
      />
      {banner}

      {!current ? (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", WebkitOverflowScrolling: "touch", padding: `12px calc(12px + ${SAFE.right}) calc(24px + ${SAFE.bottom}) calc(12px + ${SAFE.left})`, display: "grid", gap: 10, alignContent: "start" }}>
          <Empty card title={!available ? "No harness on the Mac." : loaded ? "You're caught up." : "Reading the inbox…"} style={{ marginTop: 24 }}>
            {passTotal(pass) > 0 && <div style={{ fontSize: 10.5, color: "var(--loki-fg)", marginTop: 10, fontFamily: "var(--loki-mono)", letterSpacing: "0.06em" }}>{summaryLine(pass)}</div>}
            <div style={{ fontSize: 12, color: "var(--loki-muted)", marginTop: 8 }}>{!available ? "loki's mod has not found Letta's app-server; open loki on the Mac" : !loaded ? "the Mac is listing conversations" : running > 0 ? `${running} still running` : "nothing is waiting on you"}</div>
            {snoozed.length > 0 && (
              <Button size="touch" onClick={() => setShowDeferred((v) => !v)} aria-expanded={showDeferred} style={{ marginTop: 16 }}>
                deferred · {snoozed.length}
              </Button>
            )}
          </Empty>
          {showDeferred &&
            snoozed.map((item) => (
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
            ))}
        </div>
      ) : (
        <>
          <div ref={deckRef} style={{ flex: 1, minHeight: 0, position: "relative", margin: `8px calc(10px + ${SAFE.right}) 8px calc(10px + ${SAFE.left})` }}>
            {/* The reveal, between the stack and the top card: seen on the left as the card goes right, later on the right. */}
            <div aria-hidden style={{ position: "absolute", inset: `0 0 ${PEEK}px`, zIndex: 5, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 26px", pointerEvents: "none" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--loki-positive)", fontFamily: "var(--loki-mono)", fontSize: 15, letterSpacing: "0.06em", opacity: seenReveal, transform: `scale(${0.9 + seenReveal * 0.1})` }}>
                <Check /> seen
              </span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--loki-muted)", fontFamily: "var(--loki-mono)", fontSize: 15, letterSpacing: "0.06em", opacity: laterReveal, transform: `scale(${0.9 + laterReveal * 0.1})` }}>
                later <Clock />
              </span>
            </div>

            {/* One keyed list, one component: a card keeps its DOM node as it goes shell → top → leaving, so its transform transitions between poses. */}
            {cards.map(({ item, role, index }) => {
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
                    handlers={{ onPointerDown, onPointerMove, onPointerUp: (e) => finish(e, false), onPointerCancel: (e) => finish(e, true), onClick: onCardClick }}
                    onApprove={(behavior) => {
                      if (!item.pendingApproval) return;
                      onApprove(item, item.pendingApproval.requestId, behavior);
                      commit(item, behavior === "allow" ? "approve" : "deny");
                    }}
                    onOpen={() => onOpen(item)}
                    onLater={() => commit(item, "later")}
                    onSeen={() => commit(item, "seen")}
                  />
                );
              }
              const pose = stackPose(index);
              return <Card key={idOf(item)} item={item} role={role} veil={1 - pose.opacity} style={{ zIndex: 4 - index, transform: `translateY(${pose.offsetY}px) scale(${pose.scale})`, transition: move, pointerEvents: "none" }} />;
            })}
          </div>

        </>
      )}

      {undo && (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 20, display: "flex", justifyContent: "center", zIndex: 8, pointerEvents: "none" }}>
          <Button size="touch" tone="brass" onClick={undoLast} className="loki-sheet" style={{ pointerEvents: "auto", background: "var(--loki-panel)", borderRadius: 999, padding: "0 18px", boxShadow: "var(--loki-shadow-low)" }}>
            undo {undo.via === "seen" ? "seen" : "later"}
          </Button>
        </div>
      )}
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

/** Where a card is in the deck: on top (live, draggable), behind (a shell: frame and head only), or flying off. */
type Role = "top" | "shell" | "leaving";

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
  onApprove,
  onOpen,
  onLater,
  onSeen,
}: {
  item: AttentionItem;
  role: Role;
  view?: CardView;
  refused?: boolean;
  /** 0..1: how much of the veil sits over a card behind the top one. */
  veil?: number;
  style: CSSProperties;
  handlers?: CardHandlers;
  onApprove?: (behavior: "allow" | "deny") => void;
  onOpen?: () => void;
  onLater?: () => void;
  onSeen?: () => void;
}) {
  const badge = BADGE[item.status];
  const at = item.status === "approval" ? (item.pendingApproval?.at ?? item.lastMessageAt) : item.pendingQuestion ? item.pendingQuestion.at : item.lastMessageAt;
  const since = lastSeen(at);
  /** A structured AskUserQuestion, or the last message read as a question: either way, the answer is in the conversation. */
  const asks = !!item.pendingQuestion || item.status === "question";
  const blocked = !!item.pendingApproval || asks;
  const when = blocked ? (since === "just now" ? "waiting under a minute" : `waiting ${since.replace(" ago", "")}`) : since;
  const top = role === "top";
  return (
    <article
      aria-label={`${item.title ?? item.id}, ${badge.label}`}
      aria-hidden={!top}
      {...(top ? handlers : {})}
      style={frame(item, { ...style, touchAction: "pan-y", userSelect: "none", WebkitUserSelect: "none", WebkitTapHighlightColor: "transparent", cursor: top ? "grab" : "default", outline: refused ? "2px solid var(--loki-accent)" : "none", outlineOffset: -1 })}
    >
      <Head item={item} />
      {role === "shell" && <div style={{ flex: 1 }} />}
      {/* The thread spans the card: the phone's column is the reading measure (PhoneStyles lifts the desktop's 78% cap). */}
      {role !== "shell" && view && (
        <div className="loki-phone-thread" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <CardThread rows={view.rows} status={view.status} error={item.status === "failed" ? item.error : null} style={{ padding: "8px 12px" }} />
        </div>
      )}
      {role !== "shell" && item.pendingApproval && <ApprovalCard approval={item.pendingApproval} />}
      {/* One footer row: when, then what you can do about it. Approvals decide here; questions answer in the thread. */}
      {role !== "shell" && (
        <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 6, minHeight: 40, padding: "4px 8px 4px 12px", borderTop: "1px solid var(--loki-border)" }}>
          <Meta style={{ flex: 1, minWidth: 0 }}>{when}</Meta>
          {item.pendingApproval ? (
            <>
              <Button size="touch" tone="negative" onClick={() => onApprove?.("deny")}>
                deny
              </Button>
              <Button size="touch" tone="brass" onClick={() => onApprove?.("allow")}>
                approve
              </Button>
            </>
          ) : (
            <>
              <Button size="touch" onClick={onLater} title="comes back later, later each time">
                <Clock /> later
              </Button>
              {asks ? (
                <Button size="touch" tone="brass" onClick={onOpen}>
                  answer
                </Button>
              ) : (
                <Button size="touch" onClick={onOpen}>
                  open
                </Button>
              )}
              <Button size="touch" onClick={onSeen}>
                <Check /> seen
              </Button>
            </>
          )}
        </div>
      )}
      {/* Cards behind the top one are dimmed by an opaque veil, not opacity, so the stack does not show through itself. */}
      {veil > 0 && <div aria-hidden style={{ position: "absolute", inset: 0, background: "var(--loki-veil)", opacity: veil, pointerEvents: "none" }} />}
    </article>
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
