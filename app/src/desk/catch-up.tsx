import { useEffect, useEffectEvent, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { ownerAgentOf, type AttentionItem } from "../../../core/attention/model.ts";
import type { LabelView } from "../../../core/labels.ts";
import { catchUpQueue, idOf, inboxQueue, restingCount, type Decision } from "../../../core/attention/queue.ts";
import type { Attachment } from "../../../core/attention/content.ts";
import type { SlashCommand } from "../../../core/attention/commands.ts";
import { useConversation, type ChatViews, type HandoffSource, type OutsideSource } from "../../../core/attention/use-attention.ts";
import type { ModelEntry } from "../chat/model-picker";
import { Conversation } from "../chat/conversation";
import { OpenChat } from "../chat/transcript";
import { bumpTick, tickOf, waitingCount, type ChatTick, type SuggestionSource } from "../chat/suggestion-card";
import { useInlineWidgets, type InlineWidgetSource } from "../chat/use-inline-widgets";
import { scopeFor } from "../../../core/desk-core.ts";
import { draftKey, useDraft } from "../shared/drafts";
import type { ModelSelection, ReasoningEffort } from "../../../core/models.ts";
import { AgentPills, BADGE, CardActions, CardHeader, CaughtUp, DeckHeader, KeysHint, cameBackIn, deckKey, liveWaitingCount, needsYou } from "./catch-up-parts";
import { useDeckActions } from "./use-deck-actions";
import { useDeckKeys } from "./use-deck-keys";
import { useDeckQueue } from "./use-deck-queue";
import { OutsideCard, wentTo } from "./outside-card";
import { HandoffPicker } from "./handoff-picker";
import { ReturnPicker } from "./return-picker";
import { LabelPicker } from "./label-picker";
import type { DeckMoveApi } from "./deck-moves";
import type { MoveResult } from "../../../core/attention/use-attention.ts";
import type { AccountLabel } from "../../../core/frame-types.ts";

/**
 * The Inbox: every chat you have not archived, one at a time, highest score first (core/attention/priority.ts):
 * blocked agents, then what is new, then the chats in focus, then the rest.
 *   ⌘] / →  read (it rests, then comes back)   ⌘[ / ←  later (unread, back in a day; the second time, you pick)
 *   ⌘E / E  archive (done: it leaves)          L  label (email cards)
 *   A approve  D deny   R reply   O open the chat   Z undo   Esc close
 * A reply keeps a chat's card; on an email or Slack card, the key pressed sends the reply and then makes its move.
 */

/** Status → label and colour; the phone inbox (app/src/phone/inbox.tsx) uses the same table. */
export { BADGE };
export { catchUpQueue };

/** The Inbox, as a card over the shell; nothing is mounted while it is closed, so each opening builds its queue afresh. */
export function CatchUp({ open, ...props }: CatchUpProps & { open: boolean }) {
  // Closed: nothing mounted, so each opening is a fresh visit — the queue is built from the Inbox right now.
  if (!open) return null;
  return <CatchUpDeck {...props} />;
}

interface CatchUpProps {
  onClose: () => void;
  /** The labels' colours (plan 022), for the card's chips. */
  labelList?: readonly LabelView[] | null;
  items: AttentionItem[];
  /** Read (⌘]): marked read here and out there, and rested (plan 070, R5). */
  onRead: (item: AttentionItem) => Promise<MoveResult>;
  /** Later (⌘[): left unread and put off, until `until` (ISO) when the person picked (R6, R7). */
  onLater: (item: AttentionItem, until?: string) => Promise<MoveResult>;
  /** Whether ⌘[ on the card now asks when it comes back. */
  laterAsks: (item: AttentionItem) => boolean;
  /** Archive the card (done: it leaves the Inbox), resolving to an error or null. */
  onArchive: (item: AttentionItem) => Promise<string | null>;
  /** Add Gmail labels to an email card (R12), and the account's labels for its picker. */
  onLabel: (item: AttentionItem, labelIds: string[]) => Promise<string | null>;
  labelsOf?: (item: AttentionItem) => Promise<AccountLabel[] | string>;
  /** Take back the card's last move (R14): the reason when it could not be, "handed off" after a hand-off, or null. */
  onUndo: (item: AttentionItem) => Promise<string | null>;
  /**
   * The live conversations behind the cards (useAttention's), read through useConversation, with their suggestions
   * (plan 049) and the hand-off of an outside card (plan 067); without that, outside cards have no hand off.
   */
  chats: ChatViews & SuggestionSource & Partial<HandoffSource> & Partial<OutsideSource>;
  loadHistory: (item: AttentionItem) => void;
  /** An approval moved the card past: marked read; and the undo of that. */
  onSeen: (item: AttentionItem, via: "approve" | "deny") => void;
  onUnread: (item: AttentionItem) => void;
  onApprove: (item: AttentionItem, requestId: string, behavior: "allow" | "deny" | "always") => void;
  onReply: (item: AttentionItem, text: string, images?: Attachment[]) => void;
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
  onPickMode?: (item: AttentionItem, mode: string) => Promise<void>;
  /** Slash commands the reply box offers, and the runner for the ones the deck does not handle itself (/model and /mode open the card's own chips). */
  commands?: SlashCommand[];
  onCommand?: (item: AttentionItem, id: string, args: string) => void;
  /** The deck closed: what this visit did, for analytics. Not called for a visit that decided nothing. */
  onPass?: PassSummaryHandler;
  /** A card came to the top (analytics: its dwell clock starts). */
  onShown?: (item: AttentionItem) => void;
  /** An agent pill chosen, null for All (analytics). */
  onFilter?: (agent: string | null) => void;
  /** The desks' widgets, so a card draws the ones its chat made, live, in the thread (chat/use-inline-widgets.tsx). */
  widgetSource?: InlineWidgetSource;
}

/**
 * Called when the Inbox closes after a visit that decided something: how many cards each action took, the replies, the
 * cards shown and how long the visit lasted (in milliseconds), for analytics.
 */
export type PassSummaryHandler = (pass: {
  decided: number;
  next: number;
  archive: number;
  approve: number;
  deny: number;
  replies: number;
  shown: number;
  duration_ms: number;
}) => void;

type DeckProps = CatchUpProps;

function CatchUpDeck(props: DeckProps) {
  const { onClose, items, loadHistory, onOpenDesk } = props;
  /** The agent pill on: only that agent's cards come up this visit; null is All. */
  const [agent, setAgent] = useState<string | null>(null);
  const shown = useMemo(() => (agent ? items.filter((i) => ownerAgentOf(i) === agent) : items), [items, agent]);
  /** Going through the cards Next rested, asked for at the end of the pass. */
  const [resting, setResting] = useState(false);
  const { queue, setQueue, decided: allDecided, setDecided } = useDeckQueue(shown, agent, resting);
  // What undo takes back: this agent's part of the visit.
  const decided = agent ? allDecided.filter((d) => ownerAgentOf(d.item) === agent) : allDecided;
  /** /model and /mode typed in the box open the card's own chips; the Conversation opens them on a tick. */
  const [modelTick, setModelTick] = useState(0);
  const [modeTick, setModeTick] = useState(0);
  // The card's suggestions open from its mark or /suggestions, for that card only (a later card never opens on it).
  const [suggestTick, setSuggestTick] = useState<ChatTick>(null);
  // The reply box is always there and takes focus with each card. While you are in it,
  // letters type; the deck's single-key shortcuts return when you press Esc (or click out).
  const [typingRaw, setTyping] = useState(false);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const live = useMemo(() => new Map(items.map((i) => [idOf(i), i])), [items]);

  const current = queue[0] ? (live.get(idOf(queue[0])) ?? queue[0]) : undefined;
  const { handoffPropose, handoff } = props.chats;
  const handoffSource = handoffPropose && handoff ? { handoffPropose, handoff } : null;
  const { readOutside, replyOutside } = props.chats;
  const outsideSource = readOutside ? { readOutside } : null;
  // The reply box unmounts with the last card without a blur event; without a card there is nothing to type into.
  const typing = typingRaw && !!current;

  // /model and /mode are the card's own chips; everything else goes up (loki's keymap actions, the harness's commands).
  const runCommand = (item: AttentionItem, id: string, args: string) => {
    if (id === "model" && props.onPickModel) setModelTick((t) => t + 1);
    else if (id === "mode" && props.onPickMode) setModeTick((t) => t + 1);
    else if (id === "suggestions") setSuggestTick((t) => bumpTick(t, idOf(item)));
    else props.onCommand?.(item, id, args);
  };
  // Analytics: each card that comes to the top, once per stay there (a card gets there many ways: an effect, not a handler).
  const seenCards = useRef(new Set<string>());
  const currentId = current ? idOf(current) : null;
  const cardShown = useEffectEvent((id: string) => {
    if (!current) return;
    seenCards.current.add(id);
    props.onShown?.(current);
  });
  useEffect(() => {
    if (currentId) cardShown(currentId);
  }, [currentId]);
  const actions = useDeckActions({
    current,
    decided: allDecided,
    agent,
    setDecided,
    setQueue,
    moves: deckMoveApi(props, replyOutside),
  });
  useDeckKeys({
    typing,
    current,
    decided,
    replyRef,
    read: actions.read,
    later: actions.later,
    archive: actions.archive,
    label: props.labelsOf ? actions.label : () => {},
    approve: actions.approve,
    undo: actions.undo,
    // An outside card has no chat to open until it is handed off.
    onOpenDesk: (agentId, conversationId) => {
      if (!current?.outside) onOpenDesk(agentId, conversationId);
    },
    onClose,
  });

  // Fetch the thread once when a card becomes current; live rows stream in on top of it.
  const currentAgentId = current?.agent_id;
  const currentCardId = current?.id;
  const loadCurrent = useEffectEvent(() => {
    // An outside card (plan 067) carries its own lines: there is no chat thread to fetch.
    if (current && !current.outside) loadHistory(current);
  });
  useEffect(() => loadCurrent(), [currentAgentId, currentCardId]);

  // Each card arrives with the reply box focused, so you can just type — except approvals,
  // where the decision is the point: A and D must work at once, so the box waits for R or a click.
  const hasCard = current !== undefined;
  const asksApproval = !!current?.pendingApproval;
  const asksQuestion = !!current?.pendingQuestion;
  useEffect(() => {
    if (!hasCard) return;
    if (asksApproval || asksQuestion) {
      replyRef.current?.blur();
      return;
    }
    const t = setTimeout(() => replyRef.current?.focus(), 0); // after the keystroke that brought this card has finished
    return () => clearTimeout(t);
  }, [hasCard, currentAgentId, currentCardId, asksApproval, asksQuestion]);

  // The visit's tally, read when the deck unmounts (closing it is what ends a visit).
  const [openedAt] = useState(() => Date.now());
  const passRef = useRef({ decided, replies: actions.replies, onPass: props.onPass, openedAt });
  useEffect(() => {
    passRef.current = { decided: allDecided, replies: actions.replies, onPass: props.onPass, openedAt };
  });
  useEffect(
    () => () => {
      const { decided: d, replies, onPass, openedAt: began } = passRef.current;
      if (!onPass || (!d.length && !replies)) return;
      const by = (via: Decision["via"]) => d.filter((x) => x.via === via).length;
      onPass({
        decided: d.length,
        next: by("next"),
        archive: by("archive"),
        approve: by("approve"),
        deny: by("deny"),
        replies,
        shown: seenCards.current.size,
        duration_ms: Date.now() - began,
      });
    },
    [],
  );

  // The picker open on the card on top, in the card's picker slot: where the thread goes, when the card comes back, its labels.
  const closePicker = () => actions.openPicker(null);
  const picker = !current ? null : actions.picker === "handoff" && handoffSource ? (
    <HandoffPicker
      item={current}
      source={handoffSource}
      onCancel={closePicker}
      onDone={() => {
        closePicker();
        // The thread went to its chat: the card leaves this visit, and comes back only on a new message.
        setQueue((q) => q.filter((i) => idOf(i) !== idOf(current)));
      }}
    />
  ) : actions.picker === "later" ? (
    <ReturnPicker onPick={(at) => actions.pickLater(at.toISOString())} onCancel={closePicker} />
  ) : actions.picker === "label" && props.labelsOf ? (
    <LabelPicker item={current} labelsOf={props.labelsOf} onPick={actions.pickLabels} onCancel={closePicker} />
  ) : null;

  // One column capped at the pane (minmax(0, 1fr)): an auto column grew to the card's 1100px and clipped it in a 1100-wide window.
  return (
    <div
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        inset: 0,
        background: "var(--loki-bg)",
        display: "grid",
        gridTemplateRows: "100%",
        gridTemplateColumns: "minmax(0, 1fr)",
        justifyItems: "center",
        padding: "20px 24px 16px",
        boxSizing: "border-box",
        animation: "loki-veil 160ms ease-out both",
      }}
    >
      <div style={{ width: 1100, maxWidth: "100%", height: "100%", minHeight: 0, display: "flex", flexDirection: "column", position: "relative" }}>
        <DeckHeader needYou={liveWaitingCount(shown)} chats={inboxQueue(shown).length} />
        <AgentPills items={items} agent={agent} onAgent={(a) => (setAgent(a), props.onFilter?.(a))} />
        {!current ? (
          <CaughtUp items={shown} decided={decided} replies={actions.replies} resting={resting ? 0 : restingCount(shown)} onResting={() => setResting(true)} />
        ) : current.outside ? (
          <div key={idOf(current)} style={cardFrame(needsYou(current.status) ? "var(--loki-border)" : BADGE[current.status].color, actions.dir)}>
            <OutsideCard
              current={current}
              facts={current.outside}
              flash={actions.flash}
              cameBack={cameBackIn(decided, current)}
              typing={typing}
              moves={{ read: actions.read, later: actions.later, archive: actions.archive, label: props.labelsOf ? actions.label : () => {} }}
              went={wentTo(current.outside, items)}
              onHandoff={handoffSource ? () => actions.openPicker("handoff") : undefined}
              source={outsideSource}
              box={
                replyOutside
                  ? { text: actions.reply.text, busy: actions.reply.busy, error: actions.reply.error, onText: actions.setText, onSend: actions.sendReply }
                  : undefined
              }
              replyRef={replyRef}
              onTyping={setTyping}
              onEscapeEmpty={onClose}
              picker={picker}
            />
          </div>
        ) : (
          <Card
            key={idOf(current)}
            current={current}
            decided={decided}
            typing={typing}
            setTyping={setTyping}
            replyRef={replyRef}
            actions={actions}
            deck={props}
            onCommand={(id, args) => runCommand(current, id, args)}
            modelTick={modelTick}
            modeTick={modeTick}
            suggestionsTick={tickOf(suggestTick, idOf(current))}
            onSuggestions={() => setSuggestTick((t) => bumpTick(t, idOf(current)))}
            picker={picker}
          />
        )}
        <KeysHint typing={typing} current={current} />
      </div>
    </div>
  );
}

/**
 * One card: the shared Conversation in the card's frame — its header on top, the deck's moves in the
 * last row. Keyed on the card by the deck, so the box and the chips start fresh with each conversation.
 */
function Card({
  current,
  decided,
  typing,
  setTyping,
  replyRef,
  actions,
  deck,
  onCommand,
  modelTick,
  modeTick,
  suggestionsTick,
  onSuggestions,
  picker,
}: {
  current: AttentionItem;
  decided: Decision[];
  typing: boolean;
  setTyping: (v: boolean) => void;
  replyRef: RefObject<HTMLTextAreaElement | null>;
  actions: ReturnType<typeof useDeckActions>;
  deck: DeckProps;
  onCommand: (id: string, args: string) => void;
  modelTick: number;
  modeTick: number;
  suggestionsTick: number;
  onSuggestions: () => void;
  /** The return-time picker, when the second later asks (R7), under the card's moves. */
  picker: ReactNode;
}) {
  // a waiting card keeps a neutral frame: the red is for the badge's dot, never a panel
  const badgeColor = needsYou(current.status) ? "var(--loki-border)" : BADGE[current.status].color;
  const { agent_id: agentId, id } = current;
  // The card reads its chat itself, so a streamed piece redraws the card and not the deck around it (plan 032).
  const thread = useConversation(deck.chats, agentId, id);
  const { onPickModel, onPickMode, modelFor, modeFor, reasoningEffortFor, onStop } = deck;
  const question = current.pendingQuestion;
  // The card's chat's widgets, drawn under the rows that made them; the card is the place to use them.
  const { widgets, inline } = useInlineWidgets(deck.widgetSource, scopeFor(id, agentId), thread.rows, current.agent_name ?? null);
  const layout = useMemo(() => ({ widgets, inline }), [widgets, inline]);
  // The same draft as the chat's own pane and the phone (shared/drafts.ts): a reply begun here waits there, and a saved
  // draft for this chat (plan 049) shows in the box while nothing is typed.
  const [draft, setDraft] = useDraft(draftKey(agentId, id));
  return (
    <div style={cardFrame(badgeColor, actions.dir)}>
      {/* A chip naming another chat opens it, as O opens the card's own. */}
      <OpenChat.Provider value={(agent, conversation) => (deck.onOpenDesk(agent, conversation), deck.onClose())}>
        <Conversation
          view={{
            rows: thread.rows,
            status: thread.status,
            error: current.status === "failed" ? current.error : null,
            model: modelFor?.(agentId, id) ?? null,
            reasoningEffort: reasoningEffortFor?.(agentId, id) ?? null,
            // The live thread's mode wins over the record's.
            mode: thread.mode ?? modeFor?.(agentId, id) ?? null,
            engine: thread.engine,
            approval: current.pendingApproval ?? null,
            question: current.pendingQuestion ?? null,
            older: thread.older,
            loadFailed: thread.loadFailed,
            loadStep: thread.loadStep,
          }}
          actions={{
            onSend: (text, images) => deck.onReply(current, text, images),
            onStop: onStop ? () => onStop(current) : undefined,
            onAnswer: question ? (answers) => deck.onAnswer(current, question.requestId, answers) : undefined,
            onApprove: current.pendingApproval ? actions.approve : undefined,
            commands: deck.commands,
            onCommand,
            onLoadModels: deck.onLoadModels,
            onPickModel: onPickModel && modelFor ? (selection) => onPickModel(current, selection) : undefined,
            onPickMode: onPickMode && modeFor ? (mode) => onPickMode(current, mode) : undefined,
          }}
          models={deck.models ?? null}
          layout={layout}
          agentName={current.agent_name}
          header={
            <CardHeader
              current={current}
              cameBack={cameBackIn(decided, current)}
              flash={actions.flash}
              labelList={deck.labelList}
              suggestions={waitingCount(deck.chats, current.runtime)}
              onSuggestions={onSuggestions}
            />
          }
          footer={
            <CardActions
              current={current}
              typing={typing}
              read={actions.read}
              later={actions.later}
              archive={actions.archive}
              onOpenDesk={deck.onOpenDesk}
              onClose={deck.onClose}
            />
          }
          hints={{ approve: deckKey("inbox.approve", typing), deny: deckKey("inbox.deny", typing) }}
          draft={{ value: draft, onChange: setDraft }}
          inputRef={replyRef}
          onTyping={setTyping}
          onEscapeEmpty={deck.onClose} // esc: keep a draft and hand keys back, or close an untouched deck
          onSent={actions.sent}
          modelPickerTick={modelTick}
          modeMenuTick={modeTick}
          suggestionsTick={suggestionsTick}
          suggestions={{ source: deck.chats, rt: current.runtime }}
        />
      </OpenChat.Provider>
      {picker && <div style={{ padding: "10px 18px", borderTop: "1px solid var(--loki-border)" }}>{picker}</div>}
    </div>
  );
}

/**
 * The deck's moves as the app makes them (useAttention's, plan 070 U6), from the deck's props: read, later, archive,
 * label and undo, an approval's seen and its undo, and an outside card's reply when the app can send one.
 */
function deckMoveApi(props: DeckProps, replyOutside: OutsideSource["replyOutside"] | undefined): DeckMoveApi {
  return {
    read: props.onRead,
    later: props.onLater,
    laterAsks: props.laterAsks,
    archive: props.onArchive,
    label: props.onLabel,
    undo: props.onUndo,
    replyOutside,
    seen: props.onSeen,
    unread: props.onUnread,
    approve: props.onApprove,
  };
}

/** The card's frame, a chat's or an outside thread's: its border in the badge's colour, entering from the last move's side. */
function cardFrame(borderColor: string, dir: "next" | "back"): CSSProperties {
  return {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    background: "var(--loki-panel)",
    border: `1px solid ${borderColor}`,
    borderRadius: "var(--loki-radius-lg)",
    boxShadow: "var(--loki-shadow-sheet)",
    overflow: "hidden",
    animation: `${dir === "back" ? "loki-card-back" : "loki-card-next"} 200ms ease-out`,
  };
}
