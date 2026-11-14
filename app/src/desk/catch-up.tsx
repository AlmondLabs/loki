import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { OUTSIDE_ENDS, type AttentionItem } from "../../../core/attention/model.ts";
import { otherLanesCount, type ResolvedLane } from "../../../core/attention/lanes.ts";
import type { LabelView } from "../../../core/labels.ts";
import { catchUpQueue, idOf, restingCount, type Decision } from "../../../core/attention/queue.ts";
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
import { BADGE, ChatItemHeader, FlowCaughtUp, VisitSummary, cameBackIn, deckKey, liveWaitingCount, type ChatMoves } from "./catch-up-parts";
import { flowRows } from "./flow-column";
import { ContentList, type ContentListHandle } from "../shell/content-list";
import { PlaceColumns } from "../shell/place-columns";
import type { useDeckActions } from "./use-deck-actions";
import { useDeckKeys } from "./use-deck-keys";
import { useFlowDeck, type PassSummaryHandler } from "./use-flow-deck";
import { OutsideCard, threadSourceOf, useMailCompose, wentTo } from "./outside-card";
import { addressingFor } from "./mail-address";
import { HandoffPicker } from "./handoff-picker";
import { ReturnPicker } from "./return-picker";
import { LabelPicker } from "./label-picker";
import type { DeckMoveApi } from "./deck-moves";
import type { MoveResult } from "../../../core/attention/use-attention.ts";
import type { AccountLabel } from "../../../core/frame-types.ts";

/**
 * Flow: every chat you have not archived, highest score first (core/attention/priority.ts): blocked agents, then
 * what is new, then the chats in focus, then the rest, as a list beside the selected card. ↑↓ move through the list;
 * the moves act on the selected card (useFlowDeck):
 *   ⌘] / →  read (it rests, then comes back)   ⌘[ / ←  later (unread, back in a day; the second time, you pick)
 *   ⌘E / E  archive (done: it leaves)          L  label (email cards)
 *   A approve  D deny   R reply   O open the chat   Z undo
 * A reply keeps a chat's card; on an email or Slack card, the key pressed sends the reply and then makes its move.
 * Esc in the reply box hands the keys back; it never leaves Flow (plan 2026-11-14-1330, KTD14).
 */

/** Status → label and colour; the phone inbox (app/src/phone/inbox.tsx) uses the same table. */
export { BADGE };
export { catchUpQueue };

/** What Flow's owner reads from the app: the cards, the lane, the moves out there and what a card's chat needs. */
interface FlowPlaceProps {
  /** Leave Flow: a chat was opened from a card. */
  onClose: () => void;
  /** The labels' colours (plan 022), for the card's chips. */
  labelList?: readonly LabelView[] | null;
  /** Every card in Flow, whatever the lane: the deck reads the lane's, the quiet count all of them (KTD3). */
  items: AttentionItem[];
  /** This device's active lane, null for Everything (plan 087). */
  lane: ResolvedLane | null;
  /** Switch lanes, null for Everything: the summary's Back to Everything. The sidebar's sources switch them too. */
  onLane: (lane: ResolvedLane | null) => void;
  /** Sign In… on a card whose account lost its sign-in: open Preferences › Accounts (plan 2026-11-14-0852, 1). */
  onSignIn?: () => void;
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
  /** The visit ended (leaving Flow, or the page unloading): what it did, for analytics. Not called for a visit that decided nothing. */
  onPass?: PassSummaryHandler;
  /** A card became the selection (analytics: its dwell clock starts). */
  onShown?: (item: AttentionItem) => void;
  /** The desks' widgets, so a card draws the ones its chat made, live, in the thread (chat/use-inline-widgets.tsx). */
  widgetSource?: InlineWidgetSource;
}

type DeckProps = FlowPlaceProps;

/**
 * The Flow place (plan 2026-11-14-1330, U6), Mail's message list and reading pane: the lane's cards as the list's rows
 * in the deck's order, and the selected card as the detail, its moves its toolbar's symbols. It is the place's one owner
 * (KTD1), mounted only while Flow shows, so entering Flow begins a visit and leaving it ends one (useFlowDeck). Every
 * move goes through the list, so a row the arrows have only highlighted commits before the move acts on it (AE4).
 */
export function FlowPlace(props: FlowPlaceProps) {
  const { onClose, items, lane, onOpenDesk } = props;
  const { replyOutside, composeOutside, unsendOutside } = props.chats;
  const flow = useFlowDeck({
    items,
    lane,
    moves: deckMoveApi(props, replyOutside, unsendOutside),
    onSignIn: props.onSignIn,
    onPass: props.onPass,
    onShown: props.onShown,
    loadHistory: props.loadHistory,
  });
  const { shown, current, decided, actions } = flow;
  // The quiet line: cards needing the person in the other lanes (R14, KTD5).
  const others = useMemo(() => otherLanesCount(items, lane), [items, lane]);
  /** /model and /mode typed in the box open the card's own chips; the Conversation opens them on a tick. */
  const [modelTick, setModelTick] = useState(0);
  const [modeTick, setModeTick] = useState(0);
  // The card's suggestions open from its mark or /suggestions, for that card only (a later card never opens on it).
  const [suggestTick, setSuggestTick] = useState<ChatTick>(null);
  // The reply box is always there; it takes focus on R, Return in the list or a click, never on its own as the
  // selection moves (KTD7). While you are in it, letters type; the deck's single-key shortcuts return when you press Esc
  // (or click out).
  const [typingRaw, setTyping] = useState(false);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const list = useRef<ContentListHandle>(null);
  const listHost = useRef<HTMLDivElement>(null);

  const { handoffPropose, handoff } = props.chats;
  const handoffSource = handoffPropose && handoff ? { handoffPropose, handoff } : null;
  const outsideSource = threadSourceOf(props.chats);
  // What the recipients line of the selected mail card starts from (plan 076); the keys that switch its mode need it too.
  const compose = useMailCompose(current, composeOutside ? { composeOutside } : null);
  // The reply box unmounts with the last card without a blur event; without a card there is nothing to type into.
  const typing = typingRaw && !!current;
  /** Esc in an outside card's empty box: the box lets go, and the shell moves focus to the list; Flow stays (KTD14). */
  const leaveBox = () => replyRef.current?.blur();
  // A chat replied to or answered here waits on its agent's turn, which is not an answer from elsewhere (R11).
  const deck: DeckProps = {
    ...props,
    onReply: (item, text, images) => (flow.touch(item), props.onReply(item, text, images)),
    onAnswer: (item, requestId, answers) => (flow.touch(item), props.onAnswer(item, requestId, answers)),
  };
  /** A move, on the row the person sees: the list commits a pending highlight first (AE4), then the move acts. */
  const onSelected = (run: () => void) => {
    const rows = list.current;
    if (rows) rows.act(run);
    else run();
  };
  const read = () => onSelected(actions.read);
  const later = () => onSelected(actions.later);
  const archive = () => onSelected(actions.archive);
  const label = () => onSelected(actions.label);
  const approve = (behavior: "allow" | "deny" | "always") => onSelected(() => actions.approve(behavior));

  // /model and /mode are the card's own chips; everything else goes up (loki's keymap actions, the harness's commands).
  const runCommand = (item: AttentionItem, id: string, args: string) => {
    if (id === "model" && props.onPickModel) setModelTick((t) => t + 1);
    else if (id === "mode" && props.onPickMode) setModeTick((t) => t + 1);
    else if (id === "suggestions") setSuggestTick((t) => bumpTick(t, idOf(item)));
    else props.onCommand?.(item, id, args);
  };
  /** ⇧R and F on a mail card (plan 076): the reply goes to the sender alone, or is forwarded, and the box takes focus. */
  const mailMode = (mode: "reply" | "forward") => {
    if (flow.elsewhere || current?.outside?.provider !== "gmail" || !compose || !replyOutside) return;
    actions.setMail(addressingFor(compose, mode, actions.reply.mail));
    replyRef.current?.focus();
  };
  // A card answered elsewhere keeps its place, its moves off (R11); ↓ in the list steps past it, and it goes.
  const flash = flow.elsewhere ? "Answered elsewhere" : actions.flash;
  useDeckKeys({
    typing,
    current: flow.elsewhere ? undefined : current,
    decided,
    replyRef,
    read,
    later,
    archive,
    label: props.labelsOf ? label : () => {},
    approve,
    undo: actions.undo,
    replySender: () => mailMode("reply"),
    forward: () => mailMode("forward"),
    // An outside card has no chat to open until it is handed off.
    onOpenDesk: (agentId, conversationId) => {
      if (!current?.outside) onOpenDesk(agentId, conversationId);
    },
    onClose,
  });

  // Focus stays in the list as the person moves through it (R15): entering Flow puts it on the selected row, and a move
  // that takes the focused row away hands it to the row selected after it, so the arrows keep working. Focus the
  // person put elsewhere (the reply box, the sidebar) stays there.
  const selectedId = current ? idOf(current) : null;
  const entered = useRef(false);
  useEffect(() => {
    const host = listHost.current;
    if (!host) return;
    const active = document.activeElement;
    const lost = !active || active === document.body || host.contains(active);
    if (entered.current && !lost) return;
    const rows = [...host.querySelectorAll<HTMLElement>(".loki-list-row")];
    const row = rows.find((el) => el.dataset.row === selectedId) ?? rows.at(0);
    if (!row) return;
    entered.current = true;
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  // The picker open on the selected card, in the card's picker slot: where the thread goes, when the card comes back, its labels.
  const closePicker = () => actions.openPicker(null);
  const picker = !current ? null : actions.picker === "handoff" && handoffSource ? (
    <HandoffPicker
      item={current}
      source={handoffSource}
      onCancel={closePicker}
      onDone={() => {
        closePicker();
        // The thread went to its chat: the card leaves this visit, and comes back only on a new message. A Jira card
        // stays where it is (KTD13), since only read ends it.
        if (current.outside && !OUTSIDE_ENDS[current.outside.provider].handoff) return;
        flow.remove(current);
      }}
    />
  ) : actions.picker === "later" ? (
    <ReturnPicker onPick={(at) => actions.pickLater(at.toISOString())} onCancel={closePicker} />
  ) : actions.picker === "label" && props.labelsOf ? (
    <LabelPicker item={current} labelsOf={props.labelsOf} onPick={actions.pickLabels} onCancel={closePicker} />
  ) : null;

  const title = lane ? lane.name : "Flow";
  const listColumn = (
    <div ref={listHost} className="loki-flow-list">
      <ContentList
        ref={list}
        label={title}
        title={title}
        count={liveWaitingCount(shown) || null}
        rows={flowRows(flow.rows)}
        selectedId={selectedId}
        onSelect={flow.select}
        onEnter={() => replyRef.current?.focus()}
        empty={<FlowCaughtUp resting={flow.resting ? 0 : restingCount(shown)} onResting={flow.goThrough} />}
      />
    </div>
  );

  const detail = !current ? (
    <VisitSummary items={shown} decided={decided} replies={actions.replies} others={others} onEverything={lane ? () => props.onLane(null) : undefined} />
  ) : current.outside ? (
    <div key={idOf(current)} className="loki-flow-card">
      <OutsideCard
        current={current}
        facts={current.outside}
        flash={flash}
        cameBack={cameBackIn(decided, current)}
        typing={typing}
        moves={{ read, later, archive, label: props.labelsOf ? label : () => {} }}
        off={flow.elsewhere}
        went={wentTo(current.outside, items)}
        onHandoff={handoffSource ? () => actions.openPicker("handoff") : undefined}
        onSignIn={props.onSignIn}
        source={outsideSource}
        box={
          replyOutside
            ? {
                text: actions.reply.text,
                mail: actions.reply.mail,
                busy: actions.reply.busy,
                error: actions.reply.error,
                onText: actions.setText,
                onMail: actions.setMail,
                onSend: actions.sendReply,
                thread: actions.reply.thread ?? null,
                onThread: actions.setThread,
              }
            : undefined
        }
        compose={compose}
        replyRef={replyRef}
        onTyping={setTyping}
        onEscapeEmpty={leaveBox}
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
      moves={{ read, later, archive, approve, off: flow.elsewhere }}
      flash={flash}
      deck={deck}
      onCommand={(id, args) => runCommand(current, id, args)}
      modelTick={modelTick}
      modeTick={modeTick}
      suggestionsTick={tickOf(suggestTick, idOf(current))}
      onSuggestions={() => setSuggestTick((t) => bumpTick(t, idOf(current)))}
      picker={picker}
    />
  );

  return (
    <PlaceColumns
      list={listColumn}
      detail={
        // The detail's own presses stay in it (the desk's canvas under it listens for them on the window).
        <div className="loki-flow-detail" onPointerDown={(e) => e.stopPropagation()}>
          {detail}
        </div>
      }
    />
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
  moves: deckMoves,
  flash,
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
  /** The card's moves as the list makes them, a pending highlight committed first, and whether they are off (R11). */
  moves: Pick<ChatMoves, "read" | "later" | "archive" | "approve" | "off">;
  /** The badge's word: the last move's, or that the card was answered elsewhere (R11). */
  flash: string | null;
  deck: DeckProps;
  onCommand: (id: string, args: string) => void;
  modelTick: number;
  modeTick: number;
  suggestionsTick: number;
  onSuggestions: () => void;
  /** The return-time picker, when the second later asks (R7), under the card's moves. */
  picker: ReactNode;
}) {
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
  const cameBack = cameBackIn(decided, current);
  const moves: ChatMoves = { current, typing, ...deckMoves, onOpenDesk: deck.onOpenDesk, onClose: deck.onClose };
  return (
    <div className="loki-flow-card">
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
          // The moves are the header's toolbar (U16), so the box has no row of buttons under it.
          header={
            <ChatItemHeader
              current={current}
              cameBack={cameBack}
              flash={flash}
              suggestions={waitingCount(deck.chats, current.runtime)}
              onSuggestions={onSuggestions}
              moves={moves}
            />
          }
          hints={{ approve: deckKey("inbox.approve", typing), deny: deckKey("inbox.deny", typing) }}
          draft={{ value: draft, onChange: setDraft }}
          inputRef={replyRef}
          onTyping={setTyping}
          onSent={actions.sent}
          modelPickerTick={modelTick}
          modeMenuTick={modeTick}
          suggestionsTick={suggestionsTick}
          suggestions={{ source: deck.chats, rt: current.runtime }}
        />
      </OpenChat.Provider>
      {picker && <div className="loki-card-picker">{picker}</div>}
    </div>
  );
}

/**
 * The deck's moves as the app makes them (useAttention's, plan 070 U6), from the deck's props: read, later, archive,
 * label and undo, an approval's seen and its undo, and an outside card's reply when the app can send one.
 */
function deckMoveApi(
  props: DeckProps,
  replyOutside: OutsideSource["replyOutside"] | undefined,
  unsendOutside: OutsideSource["unsendOutside"] | undefined,
): DeckMoveApi {
  return {
    read: props.onRead,
    later: props.onLater,
    laterAsks: props.laterAsks,
    archive: props.onArchive,
    label: props.onLabel,
    undo: props.onUndo,
    replyOutside,
    unsendOutside,
    seen: props.onSeen,
    unread: props.onUnread,
    approve: props.onApprove,
  };
}
