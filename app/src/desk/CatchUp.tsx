import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import { catchUpQueue, idOf, snoozedItems, stampOf, type Decision } from "../../../core/attention/queue.ts";
import type { Snooze } from "../../../core/attention/snooze.ts";
import type { ImageAttachment } from "../../../core/attention/content.ts";
import { ApprovalCard } from "../chat/ApprovalCard";
import { QuestionCard } from "../chat/QuestionCard";
import { Transcript, type TranscriptRow } from "../chat/Transcript";
import type { ModelEntry } from "../chat/ModelPicker";
import type { PermissionMode } from "../chat/PermissionMode";
import { BADGE, CardFooter, CardHeader, CaughtUp, DeckHeader, KeysHint, ReplyBox, cameBackIn, liveWaitingCount, useChipState, type ChipState } from "./CatchUpParts";
import { useDeckActions } from "./useDeckActions";
import { useDeckKeys } from "./useDeckKeys";
import { useDeckQueue } from "./useDeckQueue";

/**
 * Catch Up: one waiting conversation at a time, a decision per card.
 *   → / space  mark seen, next        ← keep unread, next
 *   A approve  D deny                 R reply       O open desk       Z undo     Esc close
 * Approvals first, then questions, failures, finished work.
 */

/** Status → label and colour; the phone inbox (app/src/phone/Inbox.tsx) uses the same table. */
export { BADGE };
export { catchUpQueue };

/**
 * The recent thread inside a card: newest at the bottom and kept there, tool calls as muted mono
 * markers (Transcript does that), a failure's error last. The desktop deck and the phone deck
 * (app/src/phone/Inbox.tsx) both render this; `style` lets the phone tighten the padding.
 */
export function CardThread({ rows, status, error, style }: { rows: TranscriptRow[] | undefined; status?: "idle" | "thinking" | "streaming"; error?: string | null; style?: CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  // Newest at the bottom. The phone keeps its deck mounted under the other tabs (display: none), where
  // scrollHeight is 0, so also scroll when the thread first gains height.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const toEnd = () => (el.scrollTop = el.scrollHeight);
    toEnd();
    let height = el.clientHeight;
    const ro = new ResizeObserver(() => {
      if (height === 0 && el.clientHeight > 0) toEnd();
      height = el.clientHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [rows?.length, status]);
  return (
    <div ref={ref} style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: "16px 20px", fontSize: 13.5, lineHeight: 1.5, color: "var(--loki-fg)", ...style }}>
      {!rows && <div style={{ color: "var(--loki-muted)", fontSize: 12 }}>loading the thread…</div>}
      {rows && rows.length === 0 && <div style={{ color: "var(--loki-muted)", fontSize: 12 }}>no transcript on disk</div>}
      {rows && <Transcript rows={rows} streaming={status === "streaming"} />}
      {status === "thinking" && <div style={{ color: "var(--loki-muted)", fontSize: 12, padding: "6px 0" }}>thinking…</div>}
      {error && <div style={{ color: "var(--loki-negative)", fontFamily: "var(--loki-mono)", fontSize: 12, marginTop: 12, overflowWrap: "anywhere" }}>{error}</div>}
    </div>
  );
}

export function CatchUp({ open, ...props }: CatchUpProps & { open: boolean }) {
  /** S: bring deferred cards back into this pass, in a quieter style. Remembered across passes. */
  const [showSnoozed, setShowSnoozed] = useState(false);
  // Closed: nothing mounted, so each opening is a fresh pass — the queue is built from what waits right now.
  if (!open) return null;
  return <CatchUpDeck {...props} showSnoozed={showSnoozed} setShowSnoozed={setShowSnoozed} />;
}

interface CatchUpProps {
  onClose: () => void;
  items: AttentionItem[];
  /** "Later" with backoff, and its undo. */
  onLater: (item: AttentionItem) => void;
  onUnsnooze: (item: AttentionItem) => void;
  /** Raw deferral records by "agentId/conversationId" (expired ones included) for the "nth time around" label. */
  snoozes: Record<string, Snooze>;
  /** The live conversation model behind a card; `rows` is undefined until loaded. */
  conversation: (agentId: string, conversationId: string) => { rows: TranscriptRow[] | undefined; status: "idle" | "thinking" | "streaming"; mode?: string | null };
  loadHistory: (item: AttentionItem) => void;
  onSeen: (item: AttentionItem) => void;
  onUnread: (item: AttentionItem) => void;
  onApprove: (item: AttentionItem, requestId: string, behavior: "allow" | "deny") => void;
  onReply: (item: AttentionItem, text: string, images?: ImageAttachment[]) => void;
  onAnswer: (item: AttentionItem, requestId: string, answers: Record<string, string | string[]>) => void;
  onOpenDesk: (agentId: string, conversationId: string) => void;
  /** The model a card's conversation runs on, and the switcher (shared with the desk chat). */
  modelFor?: (agentId: string, conversationId: string) => string | null;
  models?: ModelEntry[] | null;
  onLoadModels?: () => void;
  onPickModel?: (item: AttentionItem, handle: string) => Promise<void>;
  /** The permission mode of a card's conversation, and its setter. */
  modeFor?: (agentId: string, conversationId: string) => string | null;
  onPickMode?: (item: AttentionItem, mode: PermissionMode) => Promise<void>;
}

type DeckProps = CatchUpProps & { showSnoozed: boolean; setShowSnoozed: (update: (v: boolean) => boolean) => void };

function CatchUpDeck(props: DeckProps) {
  const { onClose, items, snoozes, conversation, loadHistory, onOpenDesk, showSnoozed, setShowSnoozed } = props;
  const chips = useChipState();
  const { queue, setQueue, decided, setDecided } = useDeckQueue(items, showSnoozed);
  // The reply box is always there and takes focus with each card. While you are in it,
  // letters type; the deck's single-key shortcuts return when you press Esc (or click out).
  const [typingRaw, setTyping] = useState(false);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const live = useMemo(() => new Map(items.map((i) => [idOf(i), i])), [items]);

  const current = queue[0] ? (live.get(idOf(queue[0])) ?? queue[0]) : undefined;
  // The reply box unmounts with the last card without a blur event; without a card there is nothing to type into.
  const typing = typingRaw && !!current;
  const thread = current ? conversation(current.agentId, current.id) : undefined;

  const actions = useDeckActions({ current, decided, setDecided, setQueue, onSeen: props.onSeen, onUnread: props.onUnread, onLater: props.onLater, onUnsnooze: props.onUnsnooze, onApprove: props.onApprove, onAnswer: props.onAnswer, onReply: props.onReply });
  useDeckKeys({ typing, current, decided, draft: actions.draft, replyRef, advance: actions.advance, approve: actions.approve, undo: actions.undo, onOpenDesk, onClose, setShowSnoozed });

  // Fetch the thread once when a card becomes current; live rows stream in on top of it.
  useEffect(() => {
    if (current) loadHistory(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.agentId, current?.id]);

  // Each card arrives with the reply box focused, so you can just type — except approvals,
  // where the decision is the point: A and D must work at once, so the box waits for R or a click.
  useEffect(() => {
    if (!current) return;
    if (current.pendingApproval || current.pendingQuestion) {
      replyRef.current?.blur();
      return;
    }
    const t = setTimeout(() => replyRef.current?.focus(), 0); // after the keystroke that brought this card has finished
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.agentId, current?.id, !!current?.pendingApproval, !!current?.pendingQuestion]);

  const total = queue.length + decided.length;
  const snoozed = snoozedItems(items);
  const nextDue = snoozed.map((i) => i.snooze!.until).sort()[0] ?? null;

  return (
    <div
      onPointerDown={(e) => e.stopPropagation()}
      style={{ position: "absolute", inset: 0, background: "var(--loki-bg)", display: "grid", gridTemplateRows: "100%", justifyItems: "center", padding: "20px 24px 16px", boxSizing: "border-box", animation: "loki-veil 160ms ease-out both" }}
    >
      <div style={{ width: 1100, maxWidth: "100%", height: "100%", minHeight: 0, display: "flex", flexDirection: "column", position: "relative" }}>
        <DeckHeader current={current} position={total - queue.length + 1} total={total} left={queue.length} liveWaiting={liveWaitingCount(items)} snoozedCount={snoozed.length} showSnoozed={showSnoozed} />
        {!current ? (
          <CaughtUp items={items} snoozedCount={snoozed.length} nextDue={nextDue} decided={decided} replies={actions.replies} />
        ) : (
          <Card key={idOf(current)} current={current} thread={thread} decided={decided} priorSnooze={snoozes[idOf(current)]} typing={typing} setTyping={setTyping} replyRef={replyRef} chips={chips} actions={actions} deck={props} />
        )}
        <KeysHint typing={typing} />
      </div>
    </div>
  );
}

/** One card: the header, the thread, the pending approval or question, the reply box, the actions. */
function Card({ current, thread, decided, priorSnooze, typing, setTyping, replyRef, chips, actions, deck }: { current: AttentionItem; thread: ReturnType<CatchUpProps["conversation"]> | undefined; decided: Decision[]; priorSnooze: Snooze | undefined; typing: boolean; setTyping: (v: boolean) => void; replyRef: RefObject<HTMLTextAreaElement | null>; chips: ChipState; actions: ReturnType<typeof useDeckActions>; deck: DeckProps }) {
  const badgeColor = BADGE[current.status].color;
  /** Today's deferral history for the current card, expired or not. */
  const timesAround = priorSnooze && priorSnooze.stamp === stampOf(current) ? priorSnooze.skips + 1 : 0;
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--loki-panel)",
        border: `1px solid ${badgeColor}`,
        borderRadius: 12,
        boxShadow: "var(--loki-shadow-sheet)",
        overflow: "hidden",
        animation: `${actions.dir === "back" ? "loki-card-back" : "loki-card-next"} 200ms ease-out`,
      }}
    >
      <CardHeader current={current} cameBack={cameBackIn(decided, current)} timesAround={timesAround} priorSnooze={priorSnooze} flash={actions.flash} />
      <CardThread rows={thread?.rows} status={thread?.status} error={current.status === "failed" ? current.error : null} />
      {current.status === "approval" && current.pendingApproval && <ApprovalCard approval={current.pendingApproval} />}
      {current.pendingQuestion && <QuestionCard question={current.pendingQuestion} onAnswer={(answers) => deck.onAnswer(current, current.pendingQuestion!.requestId, answers)} />}
      <ReplyBox current={current} replyRef={replyRef} draft={actions.draft} setDraft={actions.setDraft} images={actions.images} setImages={actions.setImages} sendReply={actions.sendReply} setTyping={setTyping} onClose={deck.onClose} />
      <CardFooter
        current={current}
        typing={typing}
        approve={actions.approve}
        advance={actions.advance}
        onOpenDesk={deck.onOpenDesk}
        onClose={deck.onClose}
        controls={{ threadMode: thread?.mode, chips, modelFor: deck.modelFor, models: deck.models ?? null, onLoadModels: deck.onLoadModels, onPickModel: deck.onPickModel, modeFor: deck.modeFor, onPickMode: deck.onPickMode }}
      />
    </div>
  );
}
