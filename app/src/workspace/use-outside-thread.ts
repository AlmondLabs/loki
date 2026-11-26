import { useCallback, useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";
import type {
  EmojiChoice,
  JiraCardTicket,
  MailCompose,
  OutsideFacts,
  OutsideMessage,
  OutsideRead,
  OutsideWindow,
  OutsideWindowAsk,
} from "../../../core/frame-types.ts";
import type { AttentionItem } from "../../../core/attention/model.ts";
import type { OutsideSource } from "../../../core/attention/use-attention.ts";
import { sentKey, type SentReplies, type SentReply, type SentSnapshot } from "../../../core/attention/sent-replies.ts";
import type { ReactControls } from "./slack-thread";
import { toggleReaction, useQuickEmoji, type EmojiSearch } from "./slack-reactions";
import { cardKey, type OpenedThread } from "./deck-moves";

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
      reacting?: ReactControls;
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

const OUTSIDE_PREFETCH_TTL_MS = 30_000;
const OUTSIDE_PREFETCH_MAX = 20;

interface CachedOutside {
  at: number;
  promise: Promise<OutsideRead | string>;
}

const outsidePrefetchCache = new WeakMap<OutsideThreadSource["readOutside"], Map<string, CachedOutside>>();

function cacheFor(read: OutsideThreadSource["readOutside"]): Map<string, CachedOutside> {
  let map = outsidePrefetchCache.get(read);
  if (!map) {
    map = new Map();
    outsidePrefetchCache.set(read, map);
  }
  return map;
}

export function prefetchOutside(item: AttentionItem, source: OutsideThreadSource | null, now: number = Date.now()): void {
  const o = item.outside;
  if (!o || !source) return;
  const key = cardKey(item);
  if (!key) return;
  const tag = o.provider === "slack" ? `${key}/` : `${key}//${o.newest_message_id}`;
  const map = cacheFor(source.readOutside);
  const existing = map.get(tag);
  if (existing && now - existing.at < OUTSIDE_PREFETCH_TTL_MS) return;
  while (map.size >= OUTSIDE_PREFETCH_MAX) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  const promise = source.readOutside(item, { ...ticketAsk(o, true) }).then((out) => {
    if (typeof out === "string" && map.get(tag)?.promise === promise) map.delete(tag);
    return out;
  });
  map.set(tag, { at: now, promise });
}

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
  const consumePrefetched = useEffectEvent(() => {
    if (!source || threadTs !== null) return null;
    const map = outsidePrefetchCache.get(source.readOutside);
    const cached = map?.get(tag);
    if (!cached) return null;
    map?.delete(tag);
    if (Date.now() - cached.at >= OUTSIDE_PREFETCH_TTL_MS) return null;
    return cached.promise;
  });
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
    void (consumePrefetched() ?? read({}))?.then((out) => {
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
  if (!w) return { kind: "read", messages, link: shown.link, ticket: shown.ticket, ...(o?.provider === "gmail" && reacting.react ? { reacting } : {}) };
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
