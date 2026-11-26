import { useCallback, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { LabelView } from "../../../core/labels.ts";
import type { AccountProvider } from "../../../core/frame-types.ts";
import { LabelChips } from "../chat/labels";
import type { AttentionItem } from "../../../core/attention/model.ts";
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
  const summary = summaryLine(pass);
  const macProblem = !available || !!banner;
  if (!loaded && !macProblem)
    return (
      <div className="loki-phone-scroll loki-phone-scroll--flush">
        <SkeletonCard label="Reading Flow…" />
      </div>
    );
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
  const done = loaded && !macProblem;
  return (
    <>
      <div className="loki-phone-scroll loki-phone-scroll--flush">
        <div className="loki-phone-empty" role="status" data-done={done || undefined}>
          <Icon name={macProblem ? "laptop" : "check"} size={32} className="loki-phone-empty-mark" />
          <p className="loki-phone-headline">{title}</p>
          <p>{line}</p>
          {summary && <p className="loki-phone-meta">This visit: {summary}</p>}
          {!macProblem && others && <p className="loki-phone-meta">{others}</p>}
          {macProblem ? (
            <Button size="touch" tone="paper" onClick={onConnection}>
              Connection Details
            </Button>
          ) : (
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
          )}
        </div>
      </div>
    </>
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

export function Reveal({ drag, width, item, typed, sending }: { drag: Drag | null; width: number; item: AttentionItem; typed: boolean; sending: boolean }) {
  const dx = drag?.dx ?? 0;
  const dy = drag?.dy ?? 0;
  const up = -dy > Math.abs(dx);
  const dir: Direction | null = up ? "up" : dx > 0 ? "right" : dx < 0 ? "left" : null;
  const gesture = dir ? gestureFor(item, dir, { typed, sending }) : null;
  const shown = gesture && "via" in gesture ? REVEAL[gesture.via] : undefined;
  const reach = up ? -dy : dx;
  const opacity = shown ? revealOpacity(reach, width) : 0;
  const ready = !!shown && armed(reach, width);
  return (
    <div aria-hidden className="loki-phone-reveal" data-dir={dir ?? undefined}>
      {shown && dir && (
        <span className={REVEAL_CLASS[dir]} data-armed={ready || undefined} style={{ opacity, transform: `scale(${0.9 + opacity * 0.1})` }}>
          <Icon name={shown.icon} size={20} /> {shown.label}
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
  const named = item.outside ? OUTSIDE_NAMED[item.outside.provider] : false;
  const title = item.outside ? (named ? outsideTitle(item.outside) : outsideWho(item.outside)) : (item.title ?? item.id);
  const who = item.outside ? senderName(item.outside.sender) : (item.agent_name ?? "agent");
  return (
    <article
      className="loki-phone-card"
      data-role={role}
      data-refused={refused || undefined}
      aria-label={top ? `${title}, with ${item.agent_name ?? "the agent"}` : undefined}
      aria-hidden={!top || undefined}
      inert={!top}
      {...(top ? handlers : {})}
      style={style}
    >
      <header className="loki-phone-card-head">
        <button
          type="button"
          className="loki-phone-card-who"
          onClick={onOpen}
          aria-label={item.outside ? `${title}, from ${who}` : `Open ${title} with ${item.agent_name ?? "the agent"}`}
          tabIndex={top ? undefined : -1}
        >
          <Avatar name={item.outside ? who : item.agent_name} src={item.outside ? null : avatarUrl(item.agent_id)} size={28} />
          <span className="loki-phone-ellipsis">{who}</span>
          {!item.outside && <Icon name="chevron-down" size={16} />}
        </button>
        <span className="loki-phone-card-desk">
          <span className="loki-phone-ellipsis loki-phone-card-title">{title}</span>
          <span aria-hidden>·</span>
          <span className="loki-phone-card-when">{waitingSince(item)}</span>
        </span>
        {onMore && (
          <button
            type="button"
            className="loki-phone-card-more"
            onClick={onMore}
            aria-haspopup="dialog"
            aria-label={`Actions for ${title}`}
            tabIndex={top ? undefined : -1}
          >
            <Icon name="more" size={20} />
          </button>
        )}
        {((item.outside && named) || item.has_draft || suggestions > 0 || (labelList !== undefined && !!item.labels?.length)) && (
          <div className="loki-phone-card-extra">
            {item.outside && named && <span className="loki-phone-ellipsis loki-phone-card-from">{outsideWho(item.outside)}</span>}
            {item.has_draft && <span className="loki-phone-card-draft">Draft</span>}
            {suggestions > 0 && (
              <button type="button" className="loki-phone-card-suggestions" onClick={onSuggestions} aria-haspopup="dialog" tabIndex={top ? undefined : -1}>
                {sentence(chipText(suggestions, false))}
              </button>
            )}
            {labelList !== undefined && <LabelChips labels={item.labels} list={labelList} max={3} />}
          </div>
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
  const agentName = item.agent_name ?? "the agent";
  const layout = useThreadLayout({ agentId: item.agent_id, conversationId: item.id, agentName: item.agent_name }, view.rows, item, item.viewedAt);
  const question = view.question ?? null;
  const approval = view.pending ?? item.pendingApproval;
  const said = cardNotice(item, view.status);
  const notice = banner ?? (said && <ThreadNotice text={said} />);
  const model = card.model;
  const onPick = model?.onPick;
  const onStop = card.onStop;
  const message = useMessageActions({ user: "You", assistant: item.agent_name ?? "Agent" });
  const openAdvisor = useCallback((advisorChat: string) => openConversation(item.agent_id, advisorChat), [item.agent_id]);
  return message.wrap(
    <OpenChat.Provider value={openConversation}>
      <OpenAdvisor.Provider value={openAdvisor}>
        {message.sheet}
        <Conversation
          touch
          dim={false}
          view={{
            rows: view.rows,
            status: view.status,
            error: item.status === "failed" ? (item.error ?? view.error ?? null) : (view.error ?? null),
            approval,
            question,
            model: model?.modelOf(item) ?? null,
            reasoningEffort: model?.effortOf(item) ?? null,
            older: view.older ?? null,
            loadFailed: view.loadFailed ?? null,
            loadStep: view.loadStep,
          }}
          models={model?.models ?? null}
          actions={{
            onLoadModels: model?.onLoad,
            onPickModel: onPick ? (selection) => onPick(item, selection) : undefined,
            onSend: (text, images = []) => card.onSend(item, text, images),
            onAnswer: question
              ? (answers) => {
                  card.onAnswer(item, question.requestId, answers);
                  onHold();
                }
              : undefined,
            onCancelQueued: (text) => card.onCancelQueued(item, text),
            onStop: onStop ? () => onStop(item) : undefined,
          }}
          agentName={agentName}
          layout={layout}
          notice={notice || null}
          placeholder={replyPlaceholder(!!question, !!approval, agentName)}
          draft={{ value: draft, onChange: setDraft }}
          onSent={onHold}
          suggestions={card.suggestions ? { ...card.suggestions, rt: item.runtime } : null}
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
