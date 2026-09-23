import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import { catchUpQueue, idOf, snoozedItems, stampOf, type Decision } from "../../../core/attention/queue.ts";
import type { Snooze } from "../../../core/attention/snooze.ts";
import type { ImageAttachment } from "../../../core/attention/content.ts";
import type { SlashCommand } from "../../../core/attention/commands.ts";
import type { TranscriptRow } from "../chat/Transcript";
import type { ModelEntry } from "../chat/ModelPicker";
import type { PermissionMode } from "../chat/PermissionMode";
import { Conversation, type ChatStatus } from "../chat/Conversation";
import type { ModelSelection, ReasoningEffort } from "../../../core/models.ts";
import { BADGE, CardActions, CardHeader, CaughtUp, DeckHeader, KeysHint, cameBackIn, liveWaitingCount, needsYou } from "./CatchUpParts";
import { useDeckActions } from "./useDeckActions";
import { useDeckKeys } from "./useDeckKeys";
import { useDeckQueue } from "./useDeckQueue";

/**
 * Catch Up: one waiting conversation at a time, a decision per card.
 *   → / space  mark seen, next        ← keep unread, next
 *   A approve  D deny                 R reply       O open desk       Z undo     Esc close
 * Highest score first (core/attention/priority.ts): blocked agents, warm replies to you, the rest. A reply keeps the card.
 */

/** Status → label and colour; the phone inbox (app/src/phone/Inbox.tsx) uses the same table. */
export { BADGE };
export { catchUpQueue };

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
  conversation: (agentId: string, conversationId: string) => { rows: TranscriptRow[] | undefined; status: ChatStatus; mode?: string | null };
  loadHistory: (item: AttentionItem) => void;
  onSeen: (item: AttentionItem) => void;
  onUnread: (item: AttentionItem) => void;
  onApprove: (item: AttentionItem, requestId: string, behavior: "allow" | "deny") => void;
  onReply: (item: AttentionItem, text: string, images?: ImageAttachment[]) => void;
  onAnswer: (item: AttentionItem, requestId: string, answers: Record<string, string | string[]>) => void;
  onOpenDesk: (agentId: string, conversationId: string) => void;
  /** The model a card's conversation runs on, and the switcher (shared with the desk chat). */
  modelFor?: (agentId: string, conversationId: string) => string | null;
  reasoningEffortFor?: (agentId: string, conversationId: string) => ReasoningEffort | null;
  models?: ModelEntry[] | null;
  onLoadModels?: () => void;
  onPickModel?: (item: AttentionItem, selection: ModelSelection) => Promise<void>;
  /** The permission mode of a card's conversation, and its setter. */
  modeFor?: (agentId: string, conversationId: string) => string | null;
  onPickMode?: (item: AttentionItem, mode: PermissionMode) => Promise<void>;
  /** Slash commands the reply box offers, and the runner for the ones the deck does not handle itself (/model and /mode open the card's own chips). */
  commands?: SlashCommand[];
  onCommand?: (item: AttentionItem, id: string, args: string) => void;
  /** The deck closed: what this pass did, for analytics. Not called for a pass that decided nothing. */
  onPass?: PassSummaryHandler;
}

export type PassSummaryHandler = (pass: { decided: number; next: number; later: number; approve: number; deny: number; replies: number }) => void;

type DeckProps = CatchUpProps & { showSnoozed: boolean; setShowSnoozed: (update: (v: boolean) => boolean) => void };

function CatchUpDeck(props: DeckProps) {
  const { onClose, items, snoozes, conversation, loadHistory, onOpenDesk, showSnoozed, setShowSnoozed } = props;
  const { queue, setQueue, decided, setDecided } = useDeckQueue(items, showSnoozed);
  /** /model and /mode typed in the box open the card's own chips; the Conversation opens them on a tick. */
  const [modelTick, setModelTick] = useState(0);
  const [modeTick, setModeTick] = useState(0);
  // The reply box is always there and takes focus with each card. While you are in it,
  // letters type; the deck's single-key shortcuts return when you press Esc (or click out).
  const [typingRaw, setTyping] = useState(false);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const live = useMemo(() => new Map(items.map((i) => [idOf(i), i])), [items]);

  const current = queue[0] ? (live.get(idOf(queue[0])) ?? queue[0]) : undefined;
  // The reply box unmounts with the last card without a blur event; without a card there is nothing to type into.
  const typing = typingRaw && !!current;
  const thread = current ? conversation(current.agentId, current.id) : undefined;

  // /model and /mode are the card's own chips; everything else goes up (loki's keymap actions, the harness's commands).
  const runCommand = (item: AttentionItem, id: string, args: string) => {
    if (id === "model" && props.onPickModel) setModelTick((t) => t + 1);
    else if (id === "mode" && props.onPickMode) setModeTick((t) => t + 1);
    else props.onCommand?.(item, id, args);
  };
  const actions = useDeckActions({ current, decided, setDecided, setQueue, snoozedShown: showSnoozed, onSeen: props.onSeen, onUnread: props.onUnread, onLater: props.onLater, onUnsnooze: props.onUnsnooze, onApprove: props.onApprove });
  useDeckKeys({ typing, current, decided, replyRef, advance: actions.advance, approve: actions.approve, undo: actions.undo, onOpenDesk, onClose, setShowSnoozed });

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

  // The pass's tally, read when the deck unmounts (closing it is what ends a pass).
  const passRef = useRef({ decided, replies: actions.replies, onPass: props.onPass });
  useEffect(() => {
    passRef.current = { decided, replies: actions.replies, onPass: props.onPass };
  });
  useEffect(
    () => () => {
      const { decided: d, replies, onPass } = passRef.current;
      if (!onPass || (!d.length && !replies)) return;
      const by = (via: Decision["via"]) => d.filter((x) => x.via === via).length;
      onPass({ decided: d.length, next: by("next"), later: by("later"), approve: by("approve"), deny: by("deny"), replies });
    },
    [],
  );

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
          <Card key={idOf(current)} current={current} thread={thread} decided={decided} priorSnooze={snoozes[idOf(current)]} typing={typing} setTyping={setTyping} replyRef={replyRef} actions={actions} deck={props} onCommand={(id, args) => runCommand(current, id, args)} modelTick={modelTick} modeTick={modeTick} />
        )}
        <KeysHint typing={typing} />
      </div>
    </div>
  );
}

/**
 * One card: the shared Conversation in the card's frame — its header on top, the deck's moves in the
 * last row. Keyed on the card by the deck, so the box and the chips start fresh with each conversation.
 */
function Card({ current, thread, decided, priorSnooze, typing, setTyping, replyRef, actions, deck, onCommand, modelTick, modeTick }: { current: AttentionItem; thread: ReturnType<CatchUpProps["conversation"]> | undefined; decided: Decision[]; priorSnooze: Snooze | undefined; typing: boolean; setTyping: (v: boolean) => void; replyRef: RefObject<HTMLTextAreaElement | null>; actions: ReturnType<typeof useDeckActions>; deck: DeckProps; onCommand: (id: string, args: string) => void; modelTick: number; modeTick: number }) {
  // a waiting card keeps a neutral frame: the red is for the badge's dot, never a panel
  const badgeColor = needsYou(current.status) ? "var(--loki-border)" : BADGE[current.status].color;
  /** Today's deferral history for the current card, expired or not. */
  const timesAround = priorSnooze && priorSnooze.stamp === stampOf(current) ? priorSnooze.skips + 1 : 0;
  const { agentId, id } = current;
  const { onPickModel, onPickMode, modelFor, modeFor, reasoningEffortFor } = deck;
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--loki-panel)",
        border: `1px solid ${badgeColor}`,
        borderRadius: "var(--loki-radius-lg)",
        boxShadow: "var(--loki-shadow-sheet)",
        overflow: "hidden",
        animation: `${actions.dir === "back" ? "loki-card-back" : "loki-card-next"} 200ms ease-out`,
      }}
    >
      <Conversation
        view={{
          rows: thread?.rows,
          status: thread?.status ?? "idle",
          error: current.status === "failed" ? current.error : null,
          model: modelFor?.(agentId, id) ?? null,
          reasoningEffort: reasoningEffortFor?.(agentId, id) ?? null,
          // The live thread's mode wins over the record's.
          mode: thread?.mode ?? modeFor?.(agentId, id) ?? null,
          approval: current.pendingApproval ?? null,
          question: current.pendingQuestion ?? null,
        }}
        actions={{
          onSend: (text, images) => deck.onReply(current, text, images),
          onAnswer: current.pendingQuestion ? (answers) => deck.onAnswer(current, current.pendingQuestion!.requestId, answers) : undefined,
          onApprove: current.pendingApproval ? actions.approve : undefined,
          commands: deck.commands,
          onCommand,
          onLoadModels: deck.onLoadModels,
          onPickModel: onPickModel && modelFor ? (selection) => onPickModel(current, selection) : undefined,
          onPickMode: onPickMode && modeFor ? (mode) => onPickMode(current, mode) : undefined,
        }}
        models={deck.models ?? null}
        agentName={current.agentName}
        header={<CardHeader current={current} cameBack={cameBackIn(decided, current)} timesAround={timesAround} priorSnooze={priorSnooze} flash={actions.flash} />}
        footer={<CardActions current={current} typing={typing} advance={actions.advance} onOpenDesk={deck.onOpenDesk} onClose={deck.onClose} />}
        hints={{ approve: typing ? "⌘↵" : "A", deny: typing ? "⌘⇧D" : "D" }}
        inputRef={replyRef}
        onTyping={setTyping}
        onEscapeEmpty={deck.onClose} // esc: keep a draft and hand keys back, or close an untouched deck
        onSent={actions.sent}
        modelPickerTick={modelTick}
        modeMenuTick={modeTick}
      />
    </div>
  );
}
