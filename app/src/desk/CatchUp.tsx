import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import { catchUpQueue, idOf, inboxQueue, type Decision } from "../../../core/attention/queue.ts";
import type { ImageAttachment } from "../../../core/attention/content.ts";
import type { SlashCommand } from "../../../core/attention/commands.ts";
import type { TranscriptRow } from "../chat/Transcript";
import type { ModelEntry } from "../chat/ModelPicker";
import type { PermissionMode } from "../chat/PermissionMode";
import { Conversation, type ChatStatus } from "../chat/Conversation";
import type { ModelSelection, ReasoningEffort } from "../../../core/models.ts";
import { AgentPills, BADGE, CardActions, CardHeader, CaughtUp, DeckHeader, KeysHint, cameBackIn, deckKey, liveWaitingCount, needsYou } from "./CatchUpParts";
import { useDeckActions } from "./useDeckActions";
import { useDeckKeys } from "./useDeckKeys";
import { useDeckQueue } from "./useDeckQueue";

/**
 * The Inbox: every chat you have not archived, one at a time, highest score first (core/attention/priority.ts):
 * blocked agents, then what is new, then the chats in focus, then the rest.
 *   ⌘] / →  next (read, move on; the chat stays for your next visit)     ⌘E / E  archive (done: it leaves)
 *   A approve  D deny   R reply   O open the chat   Z undo   Esc close
 * A reply keeps the card.
 */

/** Status → label and colour; the phone inbox (app/src/phone/Inbox.tsx) uses the same table. */
export { BADGE };
export { catchUpQueue };

export function CatchUp({ open, ...props }: CatchUpProps & { open: boolean }) {
  // Closed: nothing mounted, so each opening is a fresh visit — the queue is built from the Inbox right now.
  if (!open) return null;
  return <CatchUpDeck {...props} />;
}

interface CatchUpProps {
  onClose: () => void;
  items: AttentionItem[];
  /** Archive the chat (done: it leaves the Inbox), resolving to an error or null; and its undo. */
  onArchive: (item: AttentionItem) => Promise<string | null>;
  onUnarchive: (item: AttentionItem) => void;
  /** The live conversation model behind a card; `rows` is undefined until loaded. */
  conversation: (agentId: string, conversationId: string) => { rows: TranscriptRow[] | undefined; status: ChatStatus; mode?: string | null };
  loadHistory: (item: AttentionItem) => void;
  onSeen: (item: AttentionItem, via: "next" | "approve" | "deny") => void;
  onUnread: (item: AttentionItem) => void;
  onApprove: (item: AttentionItem, requestId: string, behavior: "allow" | "deny") => void;
  onReply: (item: AttentionItem, text: string, images?: ImageAttachment[]) => void;
  /** Stop the card's conversation's turn, so you can take over; resolves to an error or null. */
  onStop?: (item: AttentionItem) => Promise<string | null>;
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
  /** The deck closed: what this visit did, for analytics. Not called for a visit that decided nothing. */
  onPass?: PassSummaryHandler;
}

export type PassSummaryHandler = (pass: { decided: number; next: number; archive: number; approve: number; deny: number; replies: number }) => void;

type DeckProps = CatchUpProps;

function CatchUpDeck(props: DeckProps) {
  const { onClose, items, conversation, loadHistory, onOpenDesk } = props;
  /** The agent pill on: only that agent's cards come up this visit; null is All. */
  const [agent, setAgent] = useState<string | null>(null);
  const shown = useMemo(() => (agent ? items.filter((i) => i.agentId === agent) : items), [items, agent]);
  const { queue, setQueue, decided: allDecided, setDecided } = useDeckQueue(shown, agent);
  // What undo takes back: this agent's part of the visit.
  const decided = agent ? allDecided.filter((d) => d.item.agentId === agent) : allDecided;
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
  const actions = useDeckActions({ current, decided: allDecided, agent, setDecided, setQueue, onSeen: props.onSeen, onUnread: props.onUnread, onArchive: props.onArchive, onUnarchive: props.onUnarchive, onApprove: props.onApprove });
  useDeckKeys({ typing, current, decided, replyRef, next: actions.next, archive: actions.archive, approve: actions.approve, undo: actions.undo, onOpenDesk, onClose });

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

  // The visit's tally, read when the deck unmounts (closing it is what ends a visit).
  const passRef = useRef({ decided, replies: actions.replies, onPass: props.onPass });
  useEffect(() => {
    passRef.current = { decided: allDecided, replies: actions.replies, onPass: props.onPass };
  });
  useEffect(
    () => () => {
      const { decided: d, replies, onPass } = passRef.current;
      if (!onPass || (!d.length && !replies)) return;
      const by = (via: Decision["via"]) => d.filter((x) => x.via === via).length;
      onPass({ decided: d.length, next: by("next"), archive: by("archive"), approve: by("approve"), deny: by("deny"), replies });
    },
    [],
  );


  // One column capped at the pane (minmax(0, 1fr)): an auto column grew to the card's 1100px and clipped it in a 1100-wide window.
  return (
    <div
      onPointerDown={(e) => e.stopPropagation()}
      style={{ position: "absolute", inset: 0, background: "var(--loki-bg)", display: "grid", gridTemplateRows: "100%", gridTemplateColumns: "minmax(0, 1fr)", justifyItems: "center", padding: "20px 24px 16px", boxSizing: "border-box", animation: "loki-veil 160ms ease-out both" }}
    >
      <div style={{ width: 1100, maxWidth: "100%", height: "100%", minHeight: 0, display: "flex", flexDirection: "column", position: "relative" }}>
        <DeckHeader needYou={liveWaitingCount(shown)} chats={inboxQueue(shown).length} />
        <AgentPills items={items} agent={agent} onAgent={setAgent} />
        {!current ? (
          <CaughtUp items={shown} decided={decided} replies={actions.replies} />
        ) : (
          <Card key={idOf(current)} current={current} thread={thread} decided={decided} typing={typing} setTyping={setTyping} replyRef={replyRef} actions={actions} deck={props} onCommand={(id, args) => runCommand(current, id, args)} modelTick={modelTick} modeTick={modeTick} />
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
function Card({ current, thread, decided, typing, setTyping, replyRef, actions, deck, onCommand, modelTick, modeTick }: { current: AttentionItem; thread: ReturnType<CatchUpProps["conversation"]> | undefined; decided: Decision[]; typing: boolean; setTyping: (v: boolean) => void; replyRef: RefObject<HTMLTextAreaElement | null>; actions: ReturnType<typeof useDeckActions>; deck: DeckProps; onCommand: (id: string, args: string) => void; modelTick: number; modeTick: number }) {
  // a waiting card keeps a neutral frame: the red is for the badge's dot, never a panel
  const badgeColor = needsYou(current.status) ? "var(--loki-border)" : BADGE[current.status].color;
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
          onStop: deck.onStop ? () => deck.onStop!(current) : undefined,
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
        header={<CardHeader current={current} cameBack={cameBackIn(decided, current)} flash={actions.flash} />}
        footer={<CardActions current={current} typing={typing} next={actions.next} archive={actions.archive} onOpenDesk={deck.onOpenDesk} onClose={deck.onClose} />}
        hints={{ approve: deckKey("inbox.approve", typing), deny: deckKey("inbox.deny", typing) }}
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
