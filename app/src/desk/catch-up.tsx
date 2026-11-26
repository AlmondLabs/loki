import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { OUTSIDE_ENDS, type AttentionItem } from "../../../core/attention/model.ts";
import { otherLanesCount, type ResolvedLane } from "../../../core/attention/lanes.ts";
import type { LabelView } from "../../../core/labels.ts";
import { catchUpQueue, idOf, restingCount, type Decision } from "../../../core/attention/queue.ts";
import type { Attachment } from "../../../core/attention/content.ts";
import type { SlashCommand } from "../../../core/attention/commands.ts";
import { useConversation, type ChatViews, type HandoffSource, type OutsideSource } from "../../../core/attention/use-attention.ts";
import type { ModelEntry } from "../chat/model-picker";
import { Conversation } from "../chat/conversation";
import { OpenAdvisor, OpenChat } from "../chat/transcript";
import { bumpTick, tickOf, waitingCount, type ChatTick, type SuggestionSource } from "../chat/suggestion-card";
import { useInlineWidgets, type InlineWidgetSource } from "../chat/use-inline-widgets";
import { scopeFor } from "../../../core/desk-core.ts";
import { draftKey, useDraft } from "../shared/drafts";
import { useReplyHold, useTypedReplyOnCard } from "../shared/reply-hold";
import type { ModelSelection, ReasoningEffort } from "../../../core/models.ts";
import { BADGE, ChatItemHeader, FlowCaughtUp, VisitSummary, cameBackIn, deckKey, liveWaitingCount, type ChatMoves } from "./catch-up-parts";
import { flowRows, kindPills } from "./flow-column";
import type { FlowKind } from "./flow-kinds";
import { FilterPills } from "../shell/filter-pills";
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

export { BADGE };
export { catchUpQueue };

interface FlowPlaceProps {
  onClose: () => void;
  labelList?: readonly LabelView[] | null;
  items: AttentionItem[];
  lane: ResolvedLane | null;
  kind?: FlowKind;
  onKind?: (kind: FlowKind) => void;
  onLane: (lane: ResolvedLane | null) => void;
  onSignIn?: () => void;
  onRead: (item: AttentionItem) => Promise<MoveResult>;
  onLater: (item: AttentionItem, until?: string) => Promise<MoveResult>;
  laterAsks: (item: AttentionItem) => boolean;
  onArchive: (item: AttentionItem) => Promise<string | null>;
  onLabel: (item: AttentionItem, labelIds: string[]) => Promise<string | null>;
  labelsOf?: (item: AttentionItem) => Promise<AccountLabel[] | string>;
  onUndo: (item: AttentionItem) => Promise<string | null>;
  chats: ChatViews & SuggestionSource & Partial<HandoffSource> & Partial<OutsideSource>;
  loadHistory: (item: AttentionItem) => void;
  onSeen: (item: AttentionItem, via: "approve" | "deny") => void;
  onUnread: (item: AttentionItem) => void;
  onApprove: (item: AttentionItem, requestId: string, behavior: "allow" | "deny" | "always") => void;
  onReply: (item: AttentionItem, text: string, images?: Attachment[]) => void;
  onStop?: (item: AttentionItem) => Promise<string | null>;
  onAnswer: (item: AttentionItem, requestId: string, answers: Record<string, string | string[]>) => void;
  onOpenDesk: (agentId: string, conversationId: string) => void;
  onOpenAdvisor?: (agentId: string, conversationId: string) => void;
  modelFor?: (agentId: string, conversationId: string) => string | null;
  reasoningEffortFor?: (agentId: string, conversationId: string) => ReasoningEffort | null;
  models?: ModelEntry[] | null;
  onLoadModels?: () => void;
  onPickModel?: (item: AttentionItem, selection: ModelSelection) => Promise<void>;
  modeFor?: (agentId: string, conversationId: string) => string | null;
  onPickMode?: (item: AttentionItem, mode: string) => Promise<void>;
  commands?: SlashCommand[];
  onCommand?: (item: AttentionItem, id: string, args: string) => void;
  onPass?: PassSummaryHandler;
  onShown?: (item: AttentionItem) => void;
  widgetSource?: InlineWidgetSource;
}

type DeckProps = FlowPlaceProps;

export function FlowPlace(props: FlowPlaceProps) {
  const { onClose, items, lane, kind = "all", onKind, onOpenDesk } = props;
  const { replyOutside, composeOutside, unsendOutside } = props.chats;
  const outsideSource = threadSourceOf(props.chats);
  const flow = useFlowDeck({
    items,
    lane,
    kind,
    moves: deckMoveApi(props, replyOutside, unsendOutside),
    onSignIn: props.onSignIn,
    onPass: props.onPass,
    onShown: props.onShown,
    loadHistory: props.loadHistory,
    outsideSource,
  });
  const { shown, current, decided, actions } = flow;
  const others = useMemo(() => otherLanesCount(items, lane), [items, lane]);
  const [modelTick, setModelTick] = useState(0);
  const [modeTick, setModeTick] = useState(0);
  const [suggestTick, setSuggestTick] = useState<ChatTick>(null);
  const [typingRaw, setTyping] = useState(false);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const list = useRef<ContentListHandle>(null);
  const listHost = useRef<HTMLDivElement>(null);

  const { handoffPropose, handoff } = props.chats;
  const handoffSource = handoffPropose && handoff ? { handoffPropose, handoff } : null;
  const compose = useMailCompose(current, composeOutside ? { composeOutside } : null);
  const typing = typingRaw && !!current;
  useReplyHold(useTypedReplyOnCard(current ? draftKey(current.agent_id, current.id) : null, current ? idOf(current) : null));
  const leaveBox = () => replyRef.current?.blur();
  const deck: DeckProps = {
    ...props,
    onReply: (item, text, images) => (flow.touch(item), props.onReply(item, text, images)),
    onAnswer: (item, requestId, answers) => (flow.touch(item), props.onAnswer(item, requestId, answers)),
  };
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

  const runCommand = (item: AttentionItem, id: string, args: string) => {
    if (id === "model" && props.onPickModel) setModelTick((t) => t + 1);
    else if (id === "mode" && props.onPickMode) setModeTick((t) => t + 1);
    else if (id === "suggestions") setSuggestTick((t) => bumpTick(t, idOf(item)));
    else props.onCommand?.(item, id, args);
  };
  const mailMode = (mode: "reply" | "forward") => {
    if (flow.elsewhere || current?.outside?.provider !== "gmail" || !compose || !replyOutside) return;
    actions.setMail(addressingFor(compose, mode, actions.reply.mail));
    replyRef.current?.focus();
  };
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
    onOpenDesk: (agentId, conversationId) => {
      if (!current?.outside) onOpenDesk(agentId, conversationId);
    },
    onClose,
  });

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

  const closePicker = () => actions.openPicker(null);
  const picker = !current ? null : actions.picker === "handoff" && handoffSource ? (
    <HandoffPicker
      item={current}
      source={handoffSource}
      onCancel={closePicker}
      onDone={() => {
        closePicker();
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
  const pills = onKind ? kindPills(items, kind) : [];
  const listColumn = (
    <div ref={listHost} className="loki-flow-list">
      <ContentList
        ref={list}
        label={title}
        title={title}
        count={liveWaitingCount(shown) || null}
        scope={pills.length > 0 && onKind && <FilterPills pills={pills} value={kind} onValue={onKind} />}
        rows={flowRows(flow.rows)}
        divided
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
        <div className="loki-flow-detail" onPointerDown={(e) => e.stopPropagation()}>
          {detail}
        </div>
      }
    />
  );
}

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
  moves: Pick<ChatMoves, "read" | "later" | "archive" | "approve" | "off">;
  flash: string | null;
  deck: DeckProps;
  onCommand: (id: string, args: string) => void;
  modelTick: number;
  modeTick: number;
  suggestionsTick: number;
  onSuggestions: () => void;
  picker: ReactNode;
}) {
  const { agent_id: agentId, id } = current;
  const thread = useConversation(deck.chats, agentId, id);
  const { onPickModel, onPickMode, modelFor, modeFor, reasoningEffortFor, onStop, onOpenAdvisor } = deck;
  const question = current.pendingQuestion;
  const { widgets, inline } = useInlineWidgets(deck.widgetSource, scopeFor(id, agentId), thread.rows, current.agent_name ?? null);
  const layout = useMemo(() => ({ widgets, inline }), [widgets, inline]);
  const [draft, setDraft] = useDraft(draftKey(agentId, id));
  const cameBack = cameBackIn(decided, current);
  const moves: ChatMoves = { current, typing, ...deckMoves, onOpenDesk: deck.onOpenDesk, onClose: deck.onClose };
  const { onOpenDesk, onClose } = deck;
  const openChat = useCallback((agent: string, conversation: string) => (onOpenDesk(agent, conversation), onClose()), [onOpenDesk, onClose]);
  const openAdvisor = useMemo(() => (onOpenAdvisor ? () => (onOpenAdvisor(agentId, id), onClose()) : null), [onOpenAdvisor, agentId, id, onClose]);
  return (
    <div className="loki-flow-card">
      <OpenChat.Provider value={openChat}>
        <OpenAdvisor.Provider value={openAdvisor}>
          <Conversation
            view={{
              rows: thread.rows,
              status: thread.status,
              error: current.status === "failed" ? current.error : null,
              model: modelFor?.(agentId, id) ?? null,
              reasoningEffort: reasoningEffortFor?.(agentId, id) ?? null,
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
        </OpenAdvisor.Provider>
      </OpenChat.Provider>
      {picker && <div className="loki-card-picker">{picker}</div>}
    </div>
  );
}

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
