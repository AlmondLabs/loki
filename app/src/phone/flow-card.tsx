import { useCallback, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { LabelView } from "../../../core/labels.ts";
import type { AccountProvider } from "../../../core/frame-types.ts";
import { LabelChips } from "../chat/labels";
import type { AttentionItem, PendingQuestion } from "../../../core/attention/model.ts";
import { idOf } from "../../../core/attention/queue.ts";
import { useConversation, type ChatViews, type HandoffSource, type OutsideSource } from "../../../core/attention/use-attention.ts";
import { OpenAdvisor, OpenChat } from "../chat/transcript";
import { openConversation } from "./router";
import { Conversation, Thread } from "../chat/conversation";
import { bumpTick, chipText, tickOf, waitingCount, type ChatTick } from "../chat/suggestion-card";
import { avatarUrl } from "../workspace/env";
import { Button, sentence } from "../components";
import { waitingSince } from "./model";
import { Icon } from "./icons";
import { Avatar, SkeletonCard } from "./rows";
import { useMessageActions } from "./use-message-actions";
import { draftKey, useDraft } from "../shared/drafts";
import { ThreadNotice, replyPlaceholder, useThreadLayout } from "./thread-parts";
import { openFromCard } from "./transitions";
import { OutsideReply, OutsideThread, quoteOf, useMailCompose, useOutsideThread, wentTo } from "../workspace/outside-card";
import { disconnectedText, outsideTitle, outsideWho } from "../workspace/outside-words";
import { senderName } from "../workspace/mail-thread";
import { spring } from "../kit/spring";
import { useLeave } from "../kit/leave";
import {
  FLY_PAST,
  armed,
  cardNotice,
  cardsToDraw,
  flingVelocity,
  gestureFor,
  revealOpacity,
  rotationFor,
  stackPose,
  summaryLine,
  type Direction,
  type Move,
  type PassSummary,
  type Role,
  type Via,
} from "./deck";
import { newId } from "../shared/new-id";
import { useFold } from "../shared/use-fold";
import type { CardActions, CardHandlers, CardView, Deck, Drag, Leaving, Release } from "./use-flow-deck";

const UNDO_NAME: Record<Move, string> = { seen: "Undo Read", later: "Undo Later", archive: "Undo Archive" };
const UNDO_LEAVE: Keyframe[] = [{ opacity: 1 }, { opacity: 0, transform: "scale(0.8)" }];

export function UndoButton({ via, onUndo }: { via: Move; onUndo: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useLeave(ref, UNDO_LEAVE, 180);
  return (
    <button ref={ref} type="button" className="loki-phone-undo" onClick={onUndo} aria-label={UNDO_NAME[via]}>
      Undo
    </button>
  );
}

function emptyDeckCopy({
  available,
  loaded,
  banner,
  running,
  passedOver,
  resting,
  pass,
  others,
}: {
  available: boolean;
  loaded: boolean;
  banner?: ReactNode;
  running: number;
  passedOver: number;
  resting: number;
  pass: PassSummary;
  others: string | null;
}) {
  const macProblem = !available || !!banner;
  const again = loaded && !macProblem && passedOver > 0;
  const title = !available
    ? "loki is not running on the Mac"
    : banner
      ? "The Mac is out of reach"
      : again
        ? "You've been through every chat"
        : "You're caught up";
  const line = !available
    ? "Open loki on the Mac."
    : banner
      ? "Cards come back when it reconnects; nothing in Flow is lost."
      : again
        ? `${passedOver === 1 ? "1 chat still needs" : `${passedOver} chats still need`} you. Every chat stays until you archive it.`
        : resting > 0
          ? resting === 1
            ? "1 chat rests until it's due or something new comes."
            : `${resting} chats rest until they're due or something new comes.`
          : running > 0
            ? `${running} still running. They land here when they finish.`
            : "Nothing is waiting on you.";
  return {
    loading: !loaded && !macProblem,
    macProblem,
    again,
    title,
    line,
    summary: summaryLine(pass),
    done: loaded && !macProblem,
    othersText: !macProblem ? others : null,
  };
}

function EmptyDeckActions({
  macProblem,
  again,
  resting,
  onAgain,
  onResting,
  onEverything,
  backLabel,
  onClose,
  onConnection,
}: {
  macProblem: boolean;
  again: boolean;
  resting: number;
  onAgain: () => void;
  onResting: () => void;
  onEverything?: () => void;
  backLabel: string;
  onClose: () => void;
  onConnection: () => void;
}) {
  if (macProblem) {
    return (
      <Button size="touch" tone="paper" onClick={onConnection}>
        Connection Details
      </Button>
    );
  }
  return (
    <div className="loki-phone-empty-actions">
      {again && (
        <Button size="touch" tone="paper" onClick={onAgain}>
          Go Through Again
        </Button>
      )}
      {!again && resting > 0 && (
        <Button size="touch" tone="paper" onClick={onResting}>
          Go Through Them
        </Button>
      )}
      {onEverything && (
        <Button size="touch" tone="paper" onClick={onEverything}>
          Back to Everything
        </Button>
      )}
      <Button size="touch" tone="paper" onClick={onClose}>
        Back to {backLabel}
      </Button>
    </div>
  );
}

export function EmptyDeck({
  available,
  loaded,
  banner,
  running,
  passedOver,
  onAgain,
  resting,
  onResting,
  pass,
  backLabel,
  onClose,
  onConnection,
  others = null,
  onEverything,
}: {
  others?: string | null;
  onEverything?: () => void;
  available: boolean;
  loaded: boolean;
  banner?: ReactNode;
  running: number;
  passedOver: number;
  onAgain: () => void;
  resting: number;
  onResting: () => void;
  pass: PassSummary;
  backLabel: string;
  onClose: () => void;
  onConnection: () => void;
}) {
  const copy = emptyDeckCopy({ available, loaded, banner, running, passedOver, resting, pass, others });
  if (copy.loading) {
    return (
      <div className="loki-phone-scroll loki-phone-scroll--flush">
        <SkeletonCard label="Reading Flow…" />
      </div>
    );
  }
  return (
    <div className="loki-phone-scroll loki-phone-scroll--flush">
      <div className="loki-phone-empty" role="status" data-done={copy.done || undefined}>
        <Icon name={copy.macProblem ? "laptop" : "check"} size={32} className="loki-phone-empty-mark" />
        <p className="loki-phone-headline">{copy.title}</p>
        <p>{copy.line}</p>
        {copy.summary && <p className="loki-phone-meta">This visit: {copy.summary}</p>}
        {copy.othersText && <p className="loki-phone-meta">{copy.othersText}</p>}
        <EmptyDeckActions
          macProblem={copy.macProblem}
          again={copy.again}
          resting={resting}
          onAgain={onAgain}
          onResting={onResting}
          onEverything={onEverything}
          backLabel={backLabel}
          onClose={onClose}
          onConnection={onConnection}
        />
      </div>
    </div>
  );
}

const REVEAL: Partial<Record<Via, { label: string; icon: "check" | "clock" | "archive" | "close" }>> = {
  seen: { label: "Read", icon: "check" },
  later: { label: "Later", icon: "clock" },
  archive: { label: "Archive", icon: "archive" },
  approve: { label: "Approve", icon: "check" },
  deny: { label: "Deny", icon: "close" },
};

const REVEAL_CLASS: Record<Direction, string> = { right: "loki-phone-reveal-right", left: "loki-phone-reveal-left", up: "loki-phone-reveal-up" };

function revealBadge(drag: Drag | null, width: number, item: AttentionItem, typed: boolean, sending: boolean) {
  const dx = drag?.dx ?? 0;
  const dy = drag?.dy ?? 0;
  const up = -dy > Math.abs(dx);
  const dir: Direction | null = up ? "up" : dx > 0 ? "right" : dx < 0 ? "left" : null;
  if (!dir) return null;
  const gesture = gestureFor(item, dir, { typed, sending });
  const shown = "via" in gesture ? REVEAL[gesture.via] : undefined;
  if (!shown) return null;
  const reach = up ? -dy : dx;
  const opacity = revealOpacity(reach, width);
  return { dir, shown, opacity, ready: armed(reach, width) };
}

export function Reveal({ drag, width, item, typed, sending }: { drag: Drag | null; width: number; item: AttentionItem; typed: boolean; sending: boolean }) {
  const badge = revealBadge(drag, width, item, typed, sending);
  return (
    <div aria-hidden className="loki-phone-reveal" data-dir={badge?.dir ?? undefined}>
      {badge && (
        <span
          className={REVEAL_CLASS[badge.dir]}
          data-armed={badge.ready || undefined}
          style={{ opacity: badge.opacity, transform: `scale(${0.9 + badge.opacity * 0.1})` }}
        >
          <Icon name={badge.shown.icon} size={20} /> {badge.shown.label}
        </span>
      )}
    </div>
  );
}

export function Stack({
  visible,
  leaving,
  drag,
  release,
  width,
  refused,
  onMore,
  reduced,
  chats,
  handlers,
  deck,
  banner,
  card,
  onOpen,
  labelList,
  items,
  onTyped,
  onSending,
}: {
  onTyped: (item: AttentionItem, has: boolean) => void;
  onSending: (item: AttentionItem, on: boolean) => void;
  labelList: readonly LabelView[] | null;
  items: AttentionItem[];
  visible: AttentionItem[];
  leaving: Leaving | null;
  drag: Drag | null;
  release: Release | null;
  width: number;
  refused: boolean;
  onMore: () => void;
  reduced: boolean;
  chats: ChatViews & Partial<HandoffSource> & Partial<OutsideSource>;
  handlers: CardHandlers;
  deck: Deck;
  banner?: ReactNode;
  card: CardActions;
  onOpen: (item: AttentionItem) => void;
}) {
  const dx = drag?.dx ?? 0;
  const dy = drag?.dy ?? 0;
  const [suggestTick, setSuggestTick] = useState<ChatTick>(null);
  const rise = spring("smooth");
  const move = reduced ? "none" : `transform ${rise.ms}ms ${rise.easing}`;
  const sign = leaving?.dir === "left" ? -1 : 1;
  const flyTo = leaving ? (leaving.dir === "up" ? -(2 * width + FLY_PAST) : sign * (width + FLY_PAST)) : 0;
  const flung = leaving && release?.committed && release.id === idOf(leaving.item) ? release : null;
  const flungFrom = flung ? (leaving?.dir === "up" ? flung.dy : flung.dx) : 0;
  const fly = spring("smooth", flung ? flingVelocity(flungFrom, flyTo, flung.v) : 0);
  const flyTransform = leaving?.dir === "up" ? `translateY(${flyTo}px)` : `translateX(${flyTo}px) rotate(${sign * 12}deg)`;
  const homeFrom = (item: AttentionItem) =>
    release && !release.committed && release.id === idOf(item)
      ? spring("snappy", flingVelocity(Math.abs(release.dy) > Math.abs(release.dx) ? release.dy : release.dx, 0, release.v))
      : rise;
  return cardsToDraw(visible, leaving?.item ?? null).map(({ item, role, index }) => {
    if (role === "leaving")
      return (
        <Card
          key={idOf(item)}
          item={item}
          role={role}
          style={{
            zIndex: 3,
            transform: flyTransform,
            opacity: 0,
            transition: reduced ? "none" : `transform ${fly.ms}ms ${fly.easing}, opacity ${fly.ms}ms ease-in`,
          }}
        >
          {item.outside ? <OutsideBody item={item} /> : <ReadOnlyThread item={item} chats={chats} />}
        </Card>
      );
    if (role === "top") {
      return (
        <Card
          key={idOf(item)}
          item={item}
          role={role}
          refused={refused}
          onMore={onMore}
          labelList={labelList}
          suggestions={card.suggestions ? waitingCount(card.suggestions.source, item.runtime) : 0}
          onSuggestions={() => setSuggestTick((t) => bumpTick(t, idOf(item)))}
          style={{
            zIndex: 2,
            transform: drag ? `translate(${dx}px, ${dy}px) rotate(${rotationFor(dx, width)}deg)` : "none",
            transition: drag || reduced ? "none" : `transform ${homeFrom(item).ms}ms ${homeFrom(item).easing}`,
          }}
          handlers={handlers}
          onOpen={
            item.outside
              ? undefined
              : () => {
                  openFromCard();
                  onOpen(item);
                }
          }
        >
          {item.outside ? (
            <OutsideBody
              item={item}
              banner={banner}
              went={wentTo(item.outside, items)}
              outside={
                chats.readOutside && chats.replyOutside
                  ? {
                      readOutside: chats.readOutside,
                      replyOutside: chats.replyOutside,
                      composeOutside: chats.composeOutside,
                      unsendOutside: chats.unsendOutside,
                      searchPeople: chats.searchPeople,
                      pickPerson: chats.pickPerson,
                      sentReplies: chats.sentReplies,
                    }
                  : null
              }
              onTyped={(has) => onTyped(item, has)}
              onSending={(on) => onSending(item, on)}
            />
          ) : (
            <LiveCardConversation
              item={item}
              chats={chats}
              banner={banner}
              card={card}
              onHold={() => deck.hold(item)}
              suggestionsTick={tickOf(suggestTick, idOf(item))}
            />
          )}
        </Card>
      );
    }
    const pose = stackPose(index);
    return (
      <Card
        key={idOf(item)}
        item={item}
        role={role}
        veil={1 - pose.opacity}
        style={{ zIndex: 1 - index, transform: `translateY(${pose.offsetY}px) scale(${pose.scale})`, transition: move }}
      />
    );
  });
}

const OUTSIDE_NAMED: Record<AccountProvider, boolean> = { gmail: true, slack: false, jira: true };

function cardHeaderMeta(item: AttentionItem, labelList: readonly LabelView[] | null | undefined, suggestions: number) {
  const outside = item.outside;
  const named = outside ? OUTSIDE_NAMED[outside.provider] : false;
  const title = outside ? (named ? outsideTitle(outside) : outsideWho(outside)) : (item.title ?? item.id);
  const who = outside ? senderName(outside.sender) : (item.agent_name ?? "agent");
  const showFrom = !!(outside && named);
  const hasLabels = labelList !== undefined && !!item.labels?.length;
  return {
    title,
    who,
    avatarSrc: outside ? null : avatarUrl(item.agent_id),
    avatarName: outside ? who : item.agent_name,
    whoLabel: outside ? `${title}, from ${who}` : `Open ${title} with ${item.agent_name ?? "the agent"}`,
    showChevron: !outside,
    showFrom,
    outsideFrom: outside ? outsideWho(outside) : null,
    showExtra: showFrom || item.has_draft || suggestions > 0 || hasLabels,
  };
}

function CardExtra({
  item,
  outsideFrom,
  suggestions,
  onSuggestions,
  labelList,
  tabIndex,
}: {
  item: AttentionItem;
  outsideFrom: string | null;
  suggestions: number;
  onSuggestions?: () => void;
  labelList?: readonly LabelView[] | null;
  tabIndex: number | undefined;
}) {
  return (
    <div className="loki-phone-card-extra">
      {outsideFrom && <span className="loki-phone-ellipsis loki-phone-card-from">{outsideFrom}</span>}
      {item.has_draft && <span className="loki-phone-card-draft">Draft</span>}
      {suggestions > 0 && (
        <button type="button" className="loki-phone-card-suggestions" onClick={onSuggestions} aria-haspopup="dialog" tabIndex={tabIndex}>
          {sentence(chipText(suggestions, false))}
        </button>
      )}
      {labelList !== undefined && <LabelChips labels={item.labels} list={labelList} max={3} />}
    </div>
  );
}

export function Card({
  item,
  role,
  refused = false,
  veil = 0,
  style,
  handlers,
  onOpen,
  onMore,
  labelList,
  suggestions = 0,
  onSuggestions,
  children,
}: {
  item: AttentionItem;
  role: Role;
  onMore?: () => void;
  suggestions?: number;
  onSuggestions?: () => void;
  labelList?: readonly LabelView[] | null;
  refused?: boolean;
  veil?: number;
  style: CSSProperties;
  handlers?: CardHandlers;
  onOpen?: () => void;
  children?: ReactNode;
}) {
  const top = role === "top";
  const tabIndex = top ? undefined : -1;
  const meta = cardHeaderMeta(item, labelList, suggestions);
  return (
    <article
      className="loki-phone-card"
      data-role={role}
      data-refused={refused || undefined}
      aria-label={top ? `${meta.title}, with ${item.agent_name ?? "the agent"}` : undefined}
      aria-hidden={!top || undefined}
      inert={!top}
      {...(top ? handlers : {})}
      style={style}
    >
      <header className="loki-phone-card-head">
        <button type="button" className="loki-phone-card-who" onClick={onOpen} aria-label={meta.whoLabel} tabIndex={tabIndex}>
          <Avatar name={meta.avatarName} src={meta.avatarSrc} size={28} />
          <span className="loki-phone-ellipsis">{meta.who}</span>
          {meta.showChevron && <Icon name="chevron-down" size={16} />}
        </button>
        <span className="loki-phone-card-desk">
          <span className="loki-phone-ellipsis loki-phone-card-title">{meta.title}</span>
          <span aria-hidden>·</span>
          <span className="loki-phone-card-when">{waitingSince(item)}</span>
        </span>
        {onMore && (
          <button
            type="button"
            className="loki-phone-card-more"
            onClick={onMore}
            aria-haspopup="dialog"
            aria-label={`Actions for ${meta.title}`}
            tabIndex={tabIndex}
          >
            <Icon name="more" size={20} />
          </button>
        )}
        {meta.showExtra && (
          <CardExtra
            item={item}
            outsideFrom={meta.showFrom ? meta.outsideFrom : null}
            suggestions={suggestions}
            onSuggestions={onSuggestions}
            labelList={labelList}
            tabIndex={tabIndex}
          />
        )}
      </header>
      {children && <div className="loki-phone-card-body loki-phone-thread">{children}</div>}
      {veil > 0 && <div aria-hidden className="loki-phone-card-veil" style={{ opacity: veil }} />}
    </article>
  );
}

function LiveCardConversation({ chats, ...card }: { chats: ChatViews } & Omit<Parameters<typeof CardConversation>[0], "view">) {
  const view = useConversation(chats, card.item.agent_id, card.item.id);
  return <CardConversation {...card} view={view} />;
}

function cardConversationConfig(item: AttentionItem, view: CardView, banner: ReactNode | undefined, card: CardActions, onHold: () => void) {
  const agentName = item.agent_name ?? "the agent";
  const question: PendingQuestion | null = view.question ?? null;
  const approval = view.pending ?? item.pendingApproval;
  const said = cardNotice(item, view.status);
  const notice = banner ?? (said ? <ThreadNotice text={said} /> : null);
  const model = card.model;
  const onPick = model?.onPick;
  const onStop = card.onStop;
  const error = item.status === "failed" ? (item.error ?? view.error ?? null) : (view.error ?? null);
  return {
    agentName,
    notice,
    placeholder: replyPlaceholder(!!question, !!approval, agentName),
    models: model?.models ?? null,
    suggestions: card.suggestions ? { ...card.suggestions, rt: item.runtime } : null,
    conversationView: {
      rows: view.rows,
      status: view.status,
      error,
      approval,
      question,
      model: model?.modelOf(item) ?? null,
      reasoningEffort: model?.effortOf(item) ?? null,
      older: view.older ?? null,
      loadFailed: view.loadFailed ?? null,
      loadStep: view.loadStep,
    },
    conversationActions: {
      onLoadModels: model?.onLoad,
      onPickModel: onPick ? (selection: Parameters<NonNullable<typeof onPick>>[1]) => onPick(item, selection) : undefined,
      onSend: (text: string, images: Parameters<CardActions["onSend"]>[2] = []) => card.onSend(item, text, images),
      onAnswer: question
        ? (answers: Record<string, string | string[]>) => {
            card.onAnswer(item, question.requestId, answers);
            onHold();
          }
        : undefined,
      onCancelQueued: (text: string) => card.onCancelQueued(item, text),
      onStop: onStop ? () => onStop(item) : undefined,
    },
  };
}

export function CardConversation({
  item,
  view,
  banner,
  card,
  onHold,
  suggestionsTick = 0,
}: {
  item: AttentionItem;
  view: CardView;
  suggestionsTick?: number;
  banner?: ReactNode;
  card: CardActions;
  onHold: () => void;
}) {
  const [draft, setDraft] = useDraft(draftKey(item.agent_id, item.id));
  const layout = useThreadLayout({ agentId: item.agent_id, conversationId: item.id, agentName: item.agent_name }, view.rows, item, item.viewedAt);
  const cfg = cardConversationConfig(item, view, banner, card, onHold);
  const message = useMessageActions({ user: "You", assistant: item.agent_name ?? "Agent" });
  const openAdvisor = useCallback((advisorChat: string) => openConversation(item.agent_id, advisorChat), [item.agent_id]);
  return message.wrap(
    <OpenChat.Provider value={openConversation}>
      <OpenAdvisor.Provider value={openAdvisor}>
        {message.sheet}
        <Conversation
          touch
          dim={false}
          view={cfg.conversationView}
          models={cfg.models}
          actions={cfg.conversationActions}
          agentName={cfg.agentName}
          layout={layout}
          notice={cfg.notice}
          placeholder={cfg.placeholder}
          draft={{ value: draft, onChange: setDraft }}
          onSent={onHold}
          suggestions={cfg.suggestions}
          suggestionsTick={suggestionsTick}
          fold
          describe={dragWords(item)}
        />
      </OpenAdvisor.Provider>
    </OpenChat.Provider>,
  );
}

export function dragWords(item: AttentionItem): string {
  if (item.pendingApproval) return "Drag right to approve, left to deny.";
  const up = "via" in gestureFor(item, "up", { typed: false, sending: false });
  return `Drag right for Read, left for Later${up ? ", up to Archive" : ""}.`;
}

function OutsideBody({
  item,
  banner,
  went = null,
  outside = null,
  onTyped,
  onSending,
}: {
  item: AttentionItem;
  banner?: ReactNode;
  went?: string | null;
  outside?: OutsideSource | null;
  onTyped?: (has: boolean) => void;
  onSending?: (on: boolean) => void;
}) {
  const thread = useOutsideThread(item, outside);
  const fold = useFold(true);
  const compose = useMailCompose(item, outside);
  const held = useRef<string | null>(null);
  const facts = item.outside;
  if (!facts) return null;
  const unsend = outside?.unsendOutside;
  const settle = outside?.settleUnsent;
  const people = outside?.searchPeople;
  const pick = outside?.pickPerson;
  return (
    <div className="loki-phone-outside-body">
      <div className="loki-phone-outside-scroll">
        {banner}
        {facts.disconnected && <ThreadNotice text={sentence(disconnectedText(facts.disconnected, facts.provider))} />}
        {went && <span className="loki-phone-meta">{sentence(went)}</span>}
        <OutsideThread facts={facts} state={thread} touch />
      </div>
      {outside && (
        <div
          {...fold.props}
          className="loki-phone-outside-reply"
          {...(fold.folded ? {} : { onPointerDown: stopPointer, onPointerMove: stopPointer, onPointerUp: stopPointer })}
          onInput={(e) => e.target instanceof HTMLTextAreaElement && onTyped?.(!!e.target.value.trim())}
        >
          {fold.folded && <span className="loki-phone-sr-only">{dragWords(item)}</span>}
          <OutsideReply
            folded={fold.folded}
            facts={facts}
            keep={idOf(item)}
            touch
            compose={compose}
            quote={quoteOf(facts, thread)}
            searchPeople={people ? (q) => people(item, q).then((r) => (typeof r === "string" ? [] : r)) : undefined}
            onPickPerson={pick ? (p) => pick(item, p) : undefined}
            inThread={thread.kind === "read" && !!thread.opened}
            onUnsent={settle ? (outboxId, action) => settle(item, outboxId, action) : undefined}
            onUndo={
              facts.provider === "gmail" && unsend
                ? () => {
                    if (held.current) void unsend(item, held.current);
                  }
                : undefined
            }
            onSend={async (text, mail) => {
              onSending?.(true);
              const outboxId = facts.provider === "gmail" && unsend ? newId() : null;
              held.current = outboxId;
              const threadTs = thread.kind === "read" ? (thread.opened ?? null) : null;
              const extra = { mail, outbox_id: outboxId, ...(threadTs ? { thread_ts: threadTs } : {}) };
              let r: Awaited<ReturnType<typeof outside.replyOutside>>;
              try {
                r = await outside.replyOutside(item, text, "stay", extra);
              } catch (e) {
                held.current = null;
                onSending?.(false);
                throw e;
              }
              if (r.sent) {
                onTyped?.(false);
                fold.close();
              }
              held.current = null;
              onSending?.(false);
              return r;
            }}
          />
        </div>
      )}
    </div>
  );
}

const stopPointer = (e: { stopPropagation: () => void }) => e.stopPropagation();

function ReadOnlyThread({ item, chats }: { item: AttentionItem; chats: ChatViews }) {
  const view = useConversation(chats, item.agent_id, item.id);
  return (
    <Thread
      phone
      rows={view.rows}
      status={view.status}
      agentName={item.agent_name}
      dim={false}
      older={view.older ?? null}
      loadFailed={view.loadFailed ?? null}
      loadStep={view.loadStep}
    />
  );
}
