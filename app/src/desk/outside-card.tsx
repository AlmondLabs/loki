import { ItemMailThread, itemSlackRow } from "../item/outside-rows";
import { ItemReplyBox } from "../item/reply-box";
import type {
  AccountDisconnectCause,
  EmojiChoice,
  JiraCardTicket,
  SlackPerson,
  MailAddressing,
  MailCompose,
  NotSentReply,
  OutsideFacts,
  OutsideMessage,
  OutsideRead,
  OutsideWindow,
  OutsideWindowAsk,
} from "../../../core/frame-types.ts";
import {
  Fragment,
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import type { OutsideSource } from "../../../core/attention/use-attention.ts";
import { sentKey, type SentReplies, type SentReply, type SentSnapshot } from "../../../core/attention/sent-replies.ts";
import { cn } from "@/lib/utils";
import { Button, Meta, TextArea, sentence } from "../components";
import { KEYMAP, chordIds, cmdHeld, formatKeys, keyFor, type Platform } from "../shell/keymap";
import { keyboard } from "./env";
import { scrollWithin } from "../shared/scroll-within";
import { ago } from "./catch-up-parts";
import { JiraTicket } from "./jira-ticket";
import { LinkedText, MailHtml } from "./mail-html";
import { MailAddressLine, addressOf, asRecipient, startAddressing, suggest } from "./mail-address";
import { useMentions, type MentionSource } from "./mentions";
import { MAIL_INDENT, MailThread, firstLine, senderName } from "./mail-thread";
import { NewLine, SlackThread, loadLabel } from "./slack-thread";
import { toggleReaction, useQuickEmoji, type EmojiSearch } from "./slack-reactions";
import { cardKey, type OpenedThread } from "./deck-moves";
import { useSeededReply } from "./use-seeded-reply";
import { OutsideItemActions, OutsideItemHeader, type OutsideMoveHandlers } from "./outside-toolbar";
import { SEND_NOTE, SEND_TITLE, disconnectedText, replyPlace } from "./outside-words";

export function OutsideLines({ facts, touch = false }: { facts: OutsideFacts; touch?: boolean }) {
  return (
    <div className="flex flex-col" style={{ gap: touch ? "var(--phone-space-3)" : 12 }}>
      {facts.lines.map((line, i) => (
        <p key={i} style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: touch ? "var(--phone-text-body)" : "var(--text-sm)" }}>
          {line}
        </p>
      ))}
    </div>
  );
}

export function wentTo(o: OutsideFacts, items: readonly AttentionItem[]): string | null {
  if (!o.handoff_conversation_id) return null;
  const chat = items.find((i) => !i.outside && i.agent_id === o.owner_agent_id && i.id === o.handoff_conversation_id);
  return chat?.title ? `went to ${chat.title}` : "went to a chat before";
}

export interface ThreadControls {
  load: (direction: "before" | "after") => void;
  openThread: (threadTs: string) => void;
  back?: () => void;
  busy: "before" | "after" | null;
  react?: (messageId: string, choice: EmojiChoice, on: boolean) => void;
  searchEmoji?: EmojiSearch;
  quick?: EmojiChoice[];
  refusal?: { messageId: string; text: string };
}

export type OutsideThreadSource = Pick<
  OutsideSource,
  "readOutside" | "reactOutside" | "searchEmoji" | "searchPeople" | "pickPerson" | "sentReplies" | "settleUnsent"
>;

export function threadSourceOf(chats: Partial<OutsideThreadSource>): OutsideThreadSource | null {
  const { readOutside, reactOutside, searchEmoji, searchPeople, pickPerson, sentReplies, settleUnsent } = chats;
  if (!readOutside) return null;
  return {
    readOutside,
    ...(sentReplies ? { sentReplies } : {}),
    ...(reactOutside ? { reactOutside } : {}),
    ...(searchEmoji ? { searchEmoji } : {}),
    ...(searchPeople ? { searchPeople } : {}),
    ...(pickPerson ? { pickPerson } : {}),
    ...(settleUnsent ? { settleUnsent } : {}),
  };
}

export type ThreadState =
  | { kind: "loading" }
  | {
      kind: "read";
      messages: OutsideMessage[];
      window?: OutsideWindow | null;
      controls?: ThreadControls;
      opened?: string | null;
      link?: string | null;
      ticket?: JiraCardTicket | null;
    }
  | { kind: "failed"; message: string };

export interface Shown {
  view: string;
  tag: string;
  messages: OutsideMessage[];
  window: OutsideWindow | null;
  busy: "before" | "after" | null;
  failed: string | null;
  link: string | null;
  ticket: JiraCardTicket | null;
}

const firstLoaded = (messages: readonly OutsideMessage[], w: OutsideWindow) =>
  (w.view === "thread" ? messages.find((m) => m.id !== w.thread_ts) : messages[0])?.id ?? null;

export function withLoaded(now: Shown, out: OutsideRead, w: OutsideWindow, direction: "before" | "after"): Shown {
  const rest = now.messages.filter((m) => !out.messages.some((n) => n.id === m.id));
  const pinned = w.view === "thread" ? rest.filter((m) => m.id === w.thread_ts) : [];
  const body = rest.filter((m) => !pinned.includes(m));
  const more = out.window ?? w;
  return {
    ...now,
    busy: null,
    messages: direction === "before" ? [...pinned, ...out.messages, ...body] : [...rest, ...out.messages],
    window: direction === "before" ? { ...w, more_before: more.more_before } : { ...w, more_after: more.more_after },
  };
}

const tsOrder = (ts: string): string => {
  const [s = "", f = ""] = ts.split(".");
  return `${s.padStart(12, "0")}.${f.padEnd(6, "0")}`;
};

export function refreshAsk(messages: readonly OutsideMessage[], w: OutsideWindow): OutsideWindowAsk | null {
  if (w.view === "thread") return w.thread_ts ? { view: "thread", thread_ts: w.thread_ts } : null;
  const first = messages.at(0)?.id;
  const last = messages.at(-1)?.id;
  return first && last && !w.more_after ? { view: "channel", direction: "after", from: last, shown_from: first } : null;
}

export function withNewer(now: Shown, out: OutsideRead, reactedSince: ReadonlySet<string> = new Set()): Shown {
  const w = now.window;
  if (!w) return now;
  const fresh = new Map(out.messages.map((m) => [m.id, m]));
  const messages = now.messages.map((m) => {
    const f = fresh.get(m.id);
    if (!f || reactedSince.has(m.id)) return m;
    const next = { ...m };
    if (f.reactions) next.reactions = f.reactions;
    else delete next.reactions;
    return next;
  });
  const last = tsOrder(now.messages.at(-1)?.id ?? "");
  const shown = new Set(now.messages.map((m) => m.id));
  const newer = out.messages.filter((m) => !shown.has(m.id) && tsOrder(m.id) > last);
  const more = out.window?.more_after ?? false;
  if (w.more_after) return { ...now, messages, window: { ...w, more_after: more === true ? true : newer.length } };
  return { ...now, messages: [...messages, ...newer], window: { ...w, more_after: more } };
}

interface Reacted {
  seq: number;
  at: Map<string, number>;
}

const reactedAfter = (r: Reacted, asked: number): Set<string> => new Set([...r.at].filter(([, seq]) => seq > asked).map(([id]) => id));

function useReactControls(
  item: AttentionItem,
  source: OutsideThreadSource | null,
  setShown: (change: (now: Shown | null) => Shown | null) => void,
  tag: string,
  onReact: (messageId: string) => void,
): Pick<ThreadControls, "react" | "quick" | "searchEmoji" | "refusal"> {
  const o = item.outside;
  const search = source?.searchEmoji;
  const searchEmoji = search ? (q: string) => search(item, q) : null;
  const reactOutside = source?.reactOutside;
  const quick = useQuickEmoji(o?.provider === "slack" && reactOutside ? o.account_id : null, searchEmoji);
  const [refused, setRefused] = useState<{ tag: string; messageId: string; text: string } | null>(null);
  const setReactions = (messageId: string, change: (m: OutsideMessage) => OutsideMessage["reactions"]) =>
    setShown((now) => (now?.tag === tag ? { ...now, messages: now.messages.map((m) => (m.id === messageId ? { ...m, reactions: change(m) } : m)) } : now));
  const react = (messageId: string, choice: EmojiChoice, on: boolean) => {
    if (!reactOutside) return;
    onReact(messageId);
    setRefused(null);
    setReactions(messageId, (m) => toggleReaction(m.reactions ?? [], choice, on));
    void reactOutside(item, messageId, choice.name, on).then((why) => {
      if (why === null) return;
      setReactions(messageId, (m) => toggleReaction(m.reactions ?? [], choice, !on));
      setRefused({ tag, messageId, text: `Couldn't ${on ? "add" : "remove"} the reaction: ${why}` });
    });
  };
  const refusal = refused?.tag === tag ? { messageId: refused.messageId, text: refused.text } : null;
  return { ...(reactOutside ? { react, quick } : {}), ...(searchEmoji ? { searchEmoji } : {}), ...(refusal ? { refusal } : {}) };
}

const REFRESH_MS = 60_000;

function useTick(on: boolean, every: number): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") setTick((n) => n + 1);
    }, every);
    return () => clearInterval(timer);
  }, [on, every]);
  return tick;
}

const NO_SENT: SentSnapshot = { replies: [], went: 0 };

function useSentReplies(store: SentReplies | null, key: string): SentSnapshot {
  const subscribe = useCallback((fn: () => void) => (store && key ? store.subscribe(key, fn) : () => {}), [store, key]);
  const read = () => (store && key ? store.get(key) : NO_SENT);
  return useSyncExternalStore(subscribe, read, read);
}

const standIn = (r: SentReply, facts: OutsideFacts, opened: boolean): OutsideMessage => ({
  id: r.id,
  sender: "you",
  at: r.at,
  text: r.text,
  mine: true,
  ...(facts.provider === "slack" && (opened || facts.thread_id.includes(":")) ? { in_thread: true } : {}),
});

interface SentStandIns {
  went: number;
  standIns: OutsideMessage[];
  settle: (upTo: number) => void;
}

function useSentStandIns(source: OutsideThreadSource | null, facts: OutsideFacts | undefined, threadTs: string | null): SentStandIns {
  const store = source?.sentReplies ?? null;
  const key = facts ? sentKey(facts.account_id, facts.thread_id, threadTs) : "";
  const sent = useSentReplies(store, key);
  return {
    went: sent.went,
    standIns: facts ? sent.replies.map((r) => standIn(r, facts, threadTs !== null)) : [],
    settle: (upTo) => {
      if (key) store?.settle(key, upTo);
    },
  };
}

export const ticketAsk = (o: OutsideFacts | undefined, showsTicket: boolean): OutsideWindowAsk =>
  o?.provider === "jira" && showsTicket ? { ticket: true } : {};

export function useOutsideThread(
  item: AttentionItem,
  source: OutsideThreadSource | null,
  hold?: { opened: OpenedThread | null; setOpened: (opened: OpenedThread | null) => void },
): ThreadState {
  const o = item.outside;
  const key = cardKey(item);
  const [ownOpened, setOwnOpened] = useState<OpenedThread | null>(null);
  const opened = hold ? hold.opened : ownOpened;
  const setOpened = hold ? hold.setOpened : setOwnOpened;
  const threadTs = opened?.key === key ? opened.ts : null;
  const ask: OutsideWindowAsk = threadTs ? { view: "thread", thread_ts: threadTs } : {};
  const view = key ? `${key}/${threadTs ?? ""}` : "";
  const newest = o?.newest_message_id ?? "";
  const steady = o?.provider === "slack";
  const tag = steady ? view : `${view}/${newest}`;
  const [shown, setShown] = useState<Shown | null>(null);
  const reacted = useRef<Reacted>({ seq: 0, at: new Map() });
  const tick = useTick(steady && key !== "", REFRESH_MS);
  const sent = useSentStandIns(source, o, threadTs);
  const went = sent.went;
  const read = useEffectEvent((more: OutsideWindowAsk) => source?.readOutside(item, { ...ask, ...ticketAsk(item.outside, true), ...more }) ?? null);
  const settle = useEffectEvent((upTo: number) => sent.settle(upTo));
  const readNewer = useEffectEvent(() => {
    if (!steady || shown?.tag !== tag || shown.failed !== null || !shown.window) return null;
    const again = refreshAsk(shown.messages, shown.window);
    return { pending: again ? read(again) : null, asked: reacted.current.seq };
  });
  useEffect(() => {
    if (!key) return;
    let live = true;
    const stop = () => {
      live = false;
    };
    const newer = readNewer();
    if (newer) {
      void newer.pending?.then((out) => {
        if (!live || typeof out === "string") return;
        setShown((s) => (s?.tag === tag ? withNewer(s, out, reactedAfter(reacted.current, newer.asked)) : s));
        if (out.window?.more_after !== true) settle(went);
      });
      return stop;
    }
    void read({})?.then((out) => {
      if (!live) return;
      if (typeof out !== "string") {
        setShown({ view, tag, messages: out.messages, window: out.window, busy: null, failed: null, link: out.link ?? null, ticket: out.ticket ?? null });
        settle(went);
        return;
      }
      setShown((now) =>
        now?.tag === tag && now.failed === null ? now : { view, tag, messages: [], window: null, busy: null, failed: out, link: null, ticket: null },
      );
    });
    return stop;
  }, [key, tag, view, newest, went, tick]);
  const noteReacted = (messageId: string) => {
    reacted.current.seq += 1;
    reacted.current.at.set(messageId, reacted.current.seq);
  };
  const reacting = useReactControls(item, source, setShown, tag, noteReacted);
  if (!key || shown?.view !== view) return { kind: "loading" };
  if (shown.failed !== null) return { kind: "failed", message: shown.failed };
  const messages = [...shown.messages, ...sent.standIns];
  const w = shown.window;
  if (!w) return { kind: "read", messages, link: shown.link, ticket: shown.ticket };
  const load = (direction: "before" | "after") => {
    if (shown.busy) return;
    const from = direction === "before" ? firstLoaded(shown.messages, w) : (shown.messages.at(-1)?.id ?? null);
    if (!from) return;
    setShown({ ...shown, busy: direction });
    void source
      ?.readOutside(item, { ...ask, ...ticketAsk(o, shown.ticket !== null), direction, from })
      .then((out) => setShown((now) => (now?.tag !== tag ? now : typeof out === "string" ? { ...now, busy: null } : withLoaded(now, out, w, direction))));
  };
  const controls: ThreadControls = {
    load,
    openThread: (ts) => setOpened({ key, ts }),
    ...(threadTs ? { back: () => setOpened(null) } : {}),
    busy: shown.busy,
    ...reacting,
  };
  return { kind: "read", messages, window: w, controls, opened: threadTs, link: shown.link, ticket: shown.ticket };
}

export function useMailCompose(item: AttentionItem | undefined, source: Pick<OutsideSource, "composeOutside"> | null): MailCompose | null {
  const [state, setState] = useState<{ key: string; compose: MailCompose | null }>({ key: "", compose: null });
  const o = item?.outside;
  const key = o?.provider === "gmail" ? `${o.account_id}/${o.thread_id}/${o.newest_message_id}` : "";
  const read = useEffectEvent(() => (item ? (source?.composeOutside?.(item) ?? null) : null));
  useEffect(() => {
    if (!key) return;
    let live = true;
    void read()?.then((out) => {
      if (live) setState({ key, compose: typeof out === "string" ? null : out });
    });
    return () => {
      live = false;
    };
  }, [key]);
  return state.key === key ? state.compose : null;
}

export const quoteOf = (facts: OutsideFacts, state: ThreadState): string | null =>
  facts.provider === "gmail" && state.kind === "read" ? (state.messages.at(-1)?.text ?? null) : null;

function MessageRow({ m, folded }: { m: OutsideMessage; folded: boolean }) {
  const [opened, setOpened] = useState(false);
  const open = !folded || opened;
  const size = "var(--phone-text-body)";
  const who = (
    <span style={{ fontSize: size, fontWeight: 600, color: m.mine ? "var(--loki-positive)" : undefined }}>{m.mine ? "you" : senderName(m.sender)}</span>
  );
  if (!open)
    return (
      <button type="button" className="loki-mail-fold" onClick={() => setOpened(true)} aria-expanded={false}>
        {who}
        {m.at && <Meta>{ago(m.at)}</Meta>}
        <span className="loki-mail-fold-line" style={{ fontSize: size }}>
          {firstLine(m.text)}
        </span>
      </button>
    );
  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-w-0 items-baseline gap-2">
        {who}
        {m.at && <Meta>{ago(m.at)}</Meta>}
      </div>
      {m.html ? (
        <MailHtml html={m.html} title={`Mail from ${senderName(m.sender)}`} images={m.inline_images} />
      ) : (
        <p style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: size }}>
          <LinkedText text={m.text} />
        </p>
      )}
    </div>
  );
}

const NO_ADDRESSES: readonly string[] = [];

export function OutsideThread({
  facts,
  state,
  touch = false,
  own = NO_ADDRESSES,
  items = false,
}: {
  facts: OutsideFacts;
  state: ThreadState;
  touch?: boolean;
  own?: readonly string[];
  items?: boolean;
}) {
  const end = useRef<HTMLDivElement>(null);
  const newest = state.kind === "read" ? (state.messages.at(-1)?.id ?? "") : "";
  useEffect(() => {
    const el = end.current;
    if (!newest || !el) return;
    const box = el.closest<HTMLElement>("[data-thread-scroll]");
    if (box) scrollWithin(box, el, "end");
    else el.scrollIntoView({ block: "end" });
  }, [newest]);
  if (facts.provider === "jira" && state.kind === "read" && state.ticket)
    return (
      <JiraTicket ticket={state.ticket} touch={touch}>
        {touch ? <ThreadList facts={facts} state={state} /> : <SlackRows facts={facts} state={state} stays items={items} />}
      </JiraTicket>
    );
  if (state.kind !== "read" || state.messages.length === 0) return <ThreadStandIn facts={facts} state={state} touch={touch} />;
  if (touch) return <ThreadList facts={facts} state={state} endRef={end} />;
  if (facts.provider === "gmail")
    return (
      <>
        {items ? <ItemMailThread messages={state.messages} own={own} /> : <MailThread messages={state.messages} own={own} />}
        <div ref={end} />
      </>
    );
  return <SlackRows facts={facts} state={state} items={items} />;
}

function SlackRows({
  facts,
  state,
  stays = false,
  items = false,
}: {
  facts: OutsideFacts;
  state: Extract<ThreadState, { kind: "read" }>;
  stays?: boolean;
  items?: boolean;
}) {
  return (
    <SlackThread
      messages={state.messages}
      newest={facts.newest_message_id}
      window={state.window ?? null}
      controls={state.controls ?? null}
      jira={facts.provider === "jira"}
      stays={stays}
      {...(items ? { row: itemSlackRow(facts.provider) } : {})}
    />
  );
}

function ThreadStandIn({ facts, state, touch }: { facts: OutsideFacts; state: ThreadState; touch: boolean }) {
  const failed = state.kind === "failed" ? state.message : null;
  const said = failed !== null && !!facts.disconnected;
  return (
    <div className="flex flex-col" style={{ gap: touch ? "var(--phone-space-3)" : 12 }}>
      {!said && (
        <Meta wrap negative={failed !== null}>
          {failed !== null ? `Could not read the whole thread: ${failed}` : "Reading the whole thread…"}
        </Meta>
      )}
      <OutsideLines facts={facts} touch={touch} />
    </div>
  );
}

function ThreadList({
  facts,
  state,
  endRef,
}: {
  facts: OutsideFacts;
  state: Extract<ThreadState, { kind: "read" }>;
  endRef?: RefObject<HTMLDivElement | null>;
}) {
  const jira = facts.provider === "jira";
  const newAt = jira ? state.messages.findIndex((m) => m.unread === true) : -1;
  const { window: w, controls } = state;
  const earlier = jira && w && controls && w.more_before !== false && w.more_before !== 0 ? controls : null;
  const earlierLabel = earlier ? loadLabel("before", true, earlier.busy === "before") : "";
  return (
    <div className="flex flex-col" style={{ gap: "var(--phone-space-4)" }}>
      {earlier && (
        <Button size="touch" bare disabled={earlier.busy !== null} onClick={() => earlier.load("before")} className="self-center">
          {`${earlierLabel[0].toUpperCase()}${earlierLabel.slice(1)}`}
        </Button>
      )}
      {state.messages.map((m, i) => (
        <Fragment key={m.id}>
          {i === newAt && <NewLine />}
          <MessageRow m={m} folded={facts.provider === "gmail" && i < state.messages.length - 1} />
        </Fragment>
      ))}
      {endRef && <div ref={endRef} />}
    </div>
  );
}

const DECK_CHORDS = new Set(["inbox.next", "inbox.later", "inbox.archive"]);

export function replyBoxKey(e: KeyboardEvent, os: Platform = keyboard, mail = false): "deck" | "send" | "recipients" | "escape" | "own" {
  const ids = chordIds(e, KEYMAP, os);
  if (cmdHeld(e, os) && ids.some((id) => DECK_CHORDS.has(id))) return "deck";
  if (mail) {
    if (!e.isComposing && e.key === "Enter" && cmdHeld(e, os) && !e.shiftKey && !e.altKey) return "send";
    if (cmdHeld(e, os) && e.shiftKey && e.key.toLowerCase() === "c") return "recipients";
  } else if (!e.isComposing && ids.includes("chat.send")) return "send";
  return e.key === "Escape" ? "escape" : "own";
}

export interface ReplyBoxControl {
  text: string;
  mail: MailAddressing | null;
  busy: boolean;
  error: string | null;
  onText: (text: string) => void;
  onMail: (mail: MailAddressing) => void;
  onSend: () => void;
  thread?: OpenedThread | null;
  onThread?: (thread: OpenedThread | null) => void;
}

export function OutsideReply({
  facts,
  onSend,
  box,
  inputRef,
  onTyping,
  onEscapeEmpty,
  touch = false,
  actions = null,
  compose = null,
  quote = null,
  onUndo,
  keep,
  searchPeople,
  onPickPerson,
  inThread = false,
  items = false,
  onUnsent,
  folded = false,
}: {
  folded?: boolean;
  inThread?: boolean;
  items?: boolean;
  onUnsent?: (outboxId: string, action: "resend" | "discard") => Promise<string | null>;
  facts: OutsideFacts;
  keep?: string;
  searchPeople?: (query: string) => Promise<SlackPerson[]>;
  onPickPerson?: (person: SlackPerson) => void;
  onSend?: (text: string, mail: MailAddressing | null) => Promise<{ sent: boolean; error: string | null; undone?: true }>;
  compose?: MailCompose | null;
  quote?: string | null;
  onUndo?: () => void;
  box?: ReplyBoxControl;
  actions?: ReactNode;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  onTyping?: (typing: boolean) => void;
  onEscapeEmpty?: () => void;
  touch?: boolean;
}) {
  const [ownText, setOwnText] = useSeededReply(facts.seeds, keep ?? null, !!box);
  const [ownMail, setOwnMail] = useState<MailAddressing | null>(null);
  const [ownBusy, setBusy] = useState(false);
  const [ownError, setError] = useState<string | null>(null);
  const [lineOpen, setLineOpen] = useState(false);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const text = box ? box.text : ownText;
  const setText = box ? box.onText : setOwnText;
  const mail = box ? box.mail : ownMail;
  const setMail = box ? box.onMail : setOwnMail;
  const busy = box ? box.busy : ownBusy;
  const error = box ? box.error : ownError;
  const off = busy || !!facts.disconnected;
  const isMail = facts.provider === "gmail";
  const shown = compose ? (mail ?? startAddressing(compose)) : null;
  const ownRef = useRef<HTMLTextAreaElement | null>(null);
  const mentionSource: MentionSource | null =
    isMail && shown && compose
      ? {
          now: (q) => {
            const taken = new Set([...shown.to, ...shown.cc, ...shown.bcc].map((e) => addressOf(e).toLowerCase()));
            return suggest(compose.people, q, new Set()).map((p) => ({
              key: p.address,
              label: p.name || p.address,
              sub: p.name ? p.address : null,
              insert: p.name || p.address.split("@")[0],
              onPick: taken.has(p.address.toLowerCase()) ? undefined : () => setMail({ ...shown, to: [...shown.to, asRecipient(p)] }),
            }));
          },
        }
      : facts.provider === "slack" && searchPeople
        ? {
            later: (q) =>
              searchPeople(q).then((people) => ({
                list: people.map((p) => ({ key: p.id, label: p.name, sub: `@${p.handle}`, insert: p.name, onPick: () => onPickPerson?.(p) })),
              })),
          }
        : null;
  const mentions = useMentions({ text, setText, source: off ? null : mentionSource, ref: ownRef });
  const nobody = !!shown && shown.to.length + shown.cc.length + shown.bcc.length === 0;
  const send = async () => {
    if (off || !text.trim()) return;
    if (nobody) {
      setLineOpen(true);
      return;
    }
    if (box) return box.onSend();
    if (!onSend) return;
    setBusy(true);
    setError(null);
    try {
      const r = await onSend(text, mail);
      if (r.sent) {
        setOwnText("");
        setOwnMail(null);
      }
      if (r.error) setError(r.error);
    } finally {
      setBusy(false);
    }
  };
  const keys = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (mentions.onKeyDown(e)) return;
    const key = replyBoxKey(e.nativeEvent, keyboard, isMail);
    if (key === "deck") return;
    if (key !== "escape") e.stopPropagation();
    if (key === "send") {
      e.preventDefault();
      void send();
    } else if (key === "recipients") {
      e.preventDefault();
      setLineOpen(true);
    } else if (key === "escape") {
      if (!text && onEscapeEmpty) onEscapeEmpty();
      else e.currentTarget.blur();
    }
  };
  const hint = !isMail ? replyPlace(facts, inThread) : shown?.mode === "forward" ? "Add a note" : compose ? "Reply" : replyPlace(facts);
  const sendKey = isMail ? "cmd+enter" : undefined;
  const signature = shown?.signature !== false ? (compose?.from.find((f) => f.address === (shown?.from ?? compose.default_from))?.signature ?? "") : "";
  const hasSignature = !!compose?.from.find((f) => f.address === (shown?.from ?? compose.default_from))?.signature;
  const size = touch ? "var(--phone-text-body)" : "var(--text-sm)";
  const framed = isMail && !touch;
  const discard = () => {
    setText("");
    if (compose) setMail(startAddressing(compose));
    setLineOpen(false);
  };
  const notSent = facts.not_sent && <NotSentLine note={facts.not_sent} touch={touch} onUnsent={onUnsent} />;
  if (items)
    return (
      <>
        {notSent}
        <ItemReplyBox
          isMail={isMail}
          target={
            isMail ? (
              <MailAddressLine
                compose={compose}
                value={mail}
                onChange={setMail}
                open={lineOpen}
                onOpen={setLineOpen}
                onTyping={onTyping}
                touch={false}
                disabled={off}
                full
              />
            ) : (
              hint
            )
          }
          mentions={mentions.list}
          field={{
            ref: (el: HTMLTextAreaElement | null) => {
              ownRef.current = el;
              if (inputRef) inputRef.current = el;
            },
            value: text,
            disabled: off,
            placeholder: isMail ? hint : facts.provider === "jira" ? "write a comment…" : "write a reply…",
            "aria-label": hint,
            ...mentions.field,
            onChange: (e: ChangeEvent<HTMLTextAreaElement>) => {
              setText(e.target.value);
              mentions.onCaret(e.target);
            },
            onSelect: (e: SyntheticEvent<HTMLTextAreaElement>) => mentions.onCaret(e.currentTarget),
            onKeyDown: keys,
            onFocus: () => onTyping?.(true),
            onBlur: () => {
              mentions.onCaret(null);
              onTyping?.(false);
            },
          }}
          signature={isMail && compose && hasSignature ? { text: signature, toggle: () => shown && setMail({ ...shown, signature: !signature }) } : null}
          quote={isMail && compose && quote ? { text: quote, forward: shown?.mode === "forward" } : null}
          send={{
            busy,
            disabled: off || !text.trim(),
            title: nobody ? "Add someone to send it to first" : SEND_TITLE[facts.provider],
            keys: sendKey ? formatKeys(sendKey) : keyFor("chat.send"),
            onSend: () => void send(),
          }}
          discard={isMail ? { disabled: off || (!text && mail === null), onDiscard: discard } : null}
          error={error}
          actions={isMail ? null : actions}
        />
      </>
    );
  return (
    <div
      className={framed ? "loki-mail-compose" : undefined}
      style={framed ? undefined : { display: "flex", flexDirection: "column", gap: touch ? "var(--phone-space-2)" : 8 }}
    >
      {notSent}
      {isMail && !folded && (
        <div className={framed ? "loki-mail-compose-head" : undefined}>
          <MailAddressLine
            compose={compose}
            value={mail}
            onChange={setMail}
            open={lineOpen}
            onOpen={setLineOpen}
            onTyping={onTyping}
            touch={touch}
            disabled={off}
            full={!touch}
          />
        </div>
      )}
      <div className="flex flex-col" style={{ position: "relative" }}>
        {mentions.list}
        <TextArea
          ref={(el) => {
            ownRef.current = el;
            if (inputRef) inputRef.current = el;
          }}
          size={touch ? "touch" : "sm"}
          bare={framed}
          className={framed ? "loki-mail-compose-text" : undefined}
          value={text}
          rows={folded ? 1 : touch ? 4 : 3}
          disabled={off}
          placeholder={hint}
          aria-label={hint}
          {...mentions.field}
          onChange={(e) => {
            setText(e.target.value);
            mentions.onCaret(e.target);
          }}
          onSelect={(e) => mentions.onCaret(e.currentTarget)}
          onKeyDown={keys}
          onFocus={() => onTyping?.(true)}
          onBlur={() => {
            mentions.onCaret(null);
            onTyping?.(false);
          }}
        />
      </div>
      {isMail && compose && !folded && (hasSignature || quote) && (
        <div className={cn(framed && "loki-mail-compose-extra", "flex flex-col gap-1")}>
          {hasSignature && (
            <div className="flex min-w-0 items-baseline gap-2">
              {signature ? (
                <span className="min-w-0 flex-1" style={{ fontSize: size, color: "var(--loki-muted)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                  {`-- \n${signature}`}
                </span>
              ) : (
                <Meta className="flex-1">No signature</Meta>
              )}
              <button
                type="button"
                className="loki-mail-line-who flex-none"
                disabled={off}
                onClick={() => shown && setMail({ ...shown, signature: !signature })}
              >
                {signature ? "Remove" : "Add Signature"}
              </button>
            </div>
          )}
          {quote && (
            <>
              <button
                type="button"
                className="loki-mail-quote-toggle"
                aria-expanded={quoteOpen}
                aria-label="Show the quoted mail"
                title={
                  touch
                    ? undefined
                    : shown?.mode === "forward"
                      ? "The mail goes under your note, with its files"
                      : "The mail you answer goes quoted under your reply"
                }
                onClick={() => setQuoteOpen(!quoteOpen)}
              >
                •••
              </button>
              {quoteOpen && (
                <div className="loki-mail-quote" style={{ fontSize: size }}>
                  {quote}
                </div>
              )}
            </>
          )}
        </div>
      )}
      {(!folded || busy) && (
        <div className={cn(framed && "loki-mail-compose-foot", "flex items-center gap-2")}>
          <Button
            size={touch ? "touch" : "sm"}
            tone="positive"
            disabled={off || !text.trim()}
            onClick={() => void send()}
            kbd={touch ? undefined : sendKey ? formatKeys(sendKey) : keyFor("chat.send")}
            title={touch ? "Send it as you; the card stays" : nobody ? "Add someone to send it to first" : SEND_TITLE[facts.provider]}
          >
            {busy ? "Sending…" : "Send"}
          </Button>
          {touch && busy && onUndo && (
            <Button size="touch" onClick={onUndo}>
              Undo
            </Button>
          )}
          {touch && !error && !busy && <Meta wrap>{SEND_NOTE[facts.provider]}</Meta>}
          {framed && error && (
            <Meta negative wrap className="flex-1">
              {error}
            </Meta>
          )}
          {framed ? (
            <Button
              size="sm"
              bare
              disabled={off || (!text && mail === null)}
              onClick={discard}
              style={{ marginLeft: "auto" }}
              title="Clear the reply and its recipients"
            >
              Discard
            </Button>
          ) : (
            actions
          )}
        </div>
      )}
      {!framed && error && (
        <Meta negative wrap>
          {error}
        </Meta>
      )}
    </div>
  );
}

function ownAddresses(facts: OutsideFacts, compose: MailCompose | null): string[] {
  if (facts.provider !== "gmail") return [];
  return [facts.account_id.replace(/^gmail:/, ""), ...(compose?.from.map((f) => f.address) ?? [])];
}

function NotSentLine({
  note,
  touch,
  onUnsent,
}: {
  note: NotSentReply;
  touch: boolean;
  onUnsent?: (outboxId: string, action: "resend" | "discard") => Promise<string | null>;
}) {
  const [busy, setBusy] = useState<"resend" | "discard" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (action: "resend" | "discard") => {
    if (!onUnsent || busy) return;
    setBusy(action);
    setError(null);
    try {
      setError(await onUnsent(note.outbox_id, action));
    } finally {
      setBusy(null);
    }
  };
  const size = touch ? "touch" : "sm";
  return (
    <div role="alert" className="flex flex-col" style={{ gap: touch ? "var(--phone-space-1)" : 4 }}>
      <Meta negative wrap>
        Not sent: {error ?? note.reason}
      </Meta>
      <div className="flex min-w-0 items-center gap-2">
        <Meta className="min-w-0 flex-1" title={note.text}>
          “{firstLine(note.text)}”
        </Meta>
        {onUnsent && (
          <>
            <Button size={size} tone="positive" disabled={!!busy} onClick={() => void act("resend")} title="Looks in the thread first, so it never goes twice">
              {busy === "resend" ? "Sending…" : "Send Again"}
            </Button>
            <Button size={size} bare disabled={!!busy} onClick={() => void act("discard")} title="Let it go; the card stops saying it was not sent">
              Discard
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function DeckReply({
  current,
  facts,
  thread,
  source,
  box,
  replyRef,
  onTyping,
  onEscapeEmpty,
  row,
  compose,
  items = false,
}: {
  items?: boolean;
  current: AttentionItem;
  facts: OutsideFacts;
  thread: ThreadState;
  source: OutsideThreadSource | null;
  box: ReplyBoxControl;
  replyRef?: RefObject<HTMLTextAreaElement | null>;
  onTyping?: (typing: boolean) => void;
  onEscapeEmpty?: () => void;
  row?: ReactNode;
  compose: MailCompose | null;
}) {
  const people = source?.searchPeople;
  const pick = source?.pickPerson;
  const settle = source?.settleUnsent;
  return (
    <OutsideReply
      facts={facts}
      box={box}
      inputRef={replyRef}
      onTyping={onTyping}
      onEscapeEmpty={onEscapeEmpty}
      actions={row}
      compose={compose}
      quote={quoteOf(facts, thread)}
      searchPeople={people ? (q: string) => people(current, q).then((r) => (typeof r === "string" ? [] : r)) : undefined}
      onPickPerson={pick ? (p) => pick(current, p) : undefined}
      inThread={thread.kind === "read" && !!thread.opened}
      items={items}
      onUnsent={settle ? (outboxId, action) => settle(current, outboxId, action) : undefined}
    />
  );
}

function Disconnected({ facts, cause }: { facts: OutsideFacts; cause: AccountDisconnectCause }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <Meta negative wrap>
        {sentence(disconnectedText(cause, facts.provider))}
      </Meta>
    </div>
  );
}

export function OutsideCard({
  current,
  facts,
  flash,
  cameBack,
  typing,
  moves,
  went = null,
  onHandoff,
  onSignIn,
  picker = null,
  source = null,
  box,
  replyRef,
  onTyping,
  onEscapeEmpty,
  compose = null,
  off = false,
}: {
  current: AttentionItem;
  facts: OutsideFacts;
  flash: string | null;
  cameBack: boolean;
  typing: boolean;
  moves: OutsideMoveHandlers;
  went?: string | null;
  onHandoff?: () => void;
  onSignIn?: () => void;
  picker?: ReactNode;
  source?: OutsideThreadSource | null;
  box?: ReplyBoxControl;
  replyRef?: RefObject<HTMLTextAreaElement | null>;
  onTyping?: (typing: boolean) => void;
  onEscapeEmpty?: () => void;
  compose?: MailCompose | null;
  off?: boolean;
}) {
  const thread = useOutsideThread(current, source, box?.onThread ? { opened: box.thread ?? null, setOpened: box.onThread } : undefined);
  const actions = (
    <OutsideItemActions facts={facts} thread={thread} typing={typing} moves={moves} onHandoff={onHandoff} onSignIn={onSignIn} picking={!!picker} off={off} />
  );
  const mailBox = facts.provider === "gmail" && !!box;
  const own = ownAddresses(facts, compose);
  const reply = box ? (
    <DeckReply
      current={current}
      facts={facts}
      thread={thread}
      source={source}
      box={box}
      replyRef={replyRef}
      onTyping={onTyping}
      onEscapeEmpty={onEscapeEmpty}
      compose={compose}
      items
    />
  ) : null;
  return (
    <div className="flex flex-1 flex-col" style={{ minHeight: 0 }}>
      <OutsideItemHeader facts={facts} unread={current.unread} flash={flash} went={went} cameBack={cameBack} thread={thread} actions={actions} />
      <div data-thread-scroll className="flex-1" style={{ minHeight: 0, overflow: "auto" }}>
        <div className="mx-auto w-full max-w-3xl" style={{ padding: facts.provider === "slack" ? "8px 20px 16px" : "16px 20px" }}>
          {facts.disconnected && <Disconnected facts={facts} cause={facts.disconnected} />}
          <OutsideThread facts={facts} state={thread} own={own} items />
          {mailBox && <div style={{ marginLeft: MAIL_INDENT, marginTop: 16 }}>{reply}</div>}
        </div>
      </div>
      {picker && <div className="loki-card-picker">{picker}</div>}
      {reply && !mailBox && (
        <div className="mx-auto w-full max-w-3xl" style={{ padding: "12px 20px 16px" }}>
          {reply}
        </div>
      )}
    </div>
  );
}
