/**
 * The replies the person sent alone from an outside card (plan 086), kept by account and thread so the card's thread
 * shows them at once: the card reads its thread again only when one went, and Slack or Gmail is slower to say so.
 */

/** One reply as the card shows it before its thread is read again. */
export interface SentReply {
  /** This store's own id, never the service's. */
  id: string;
  text: string;
  /** When it was sent, ISO. */
  at: string;
  /** It went: the next read of the thread holds it. */
  gone: boolean;
  /** The store's count of replies gone in this thread when this one went; a read made after it shows it. */
  seq: number;
}

/** What a thread's replies read as: those still shown, and how many went, which a card reads again on. */
export interface SentSnapshot {
  replies: readonly SentReply[];
  went: number;
}

/** A thread's key in the store: its account and thread, and the post's thread opened on the card that the reply went into. */
export const sentKey = (accountId: string, threadId: string, opened: string | null = null): string => `${accountId}\u0000${threadId}\u0000${opened ?? ""}`;

const EMPTY: SentSnapshot = Object.freeze({ replies: [], went: 0 });

/** A store of sent replies (`SentSnapshot` by `sentKey`), with a subscription for each thread. */
export interface SentReplies {
  /** A reply starts on its way; returns its id. */
  add: (key: string, text: string, at: string) => string;
  /** The reply went. */
  went: (id: string) => void;
  /** The reply was undone or failed: it goes. */
  drop: (id: string) => void;
  /** A read of the thread came back that was made once `went` replies had gone: those are in it now. */
  settle: (key: string, went: number) => void;
  get: (key: string) => SentSnapshot;
  subscribe: (key: string, fn: () => void) => () => void;
}

/** A new, empty store. */
export function createSentReplies(): SentReplies {
  const snaps = new Map<string, SentSnapshot>();
  const keyOf = new Map<string, string>();
  const subs = new Map<string, Set<() => void>>();
  let next = 0;
  const set = (key: string, snap: SentSnapshot) => {
    if (snap.replies.length === 0 && snap.went === 0) snaps.delete(key);
    else snaps.set(key, snap);
    subs.get(key)?.forEach((fn) => fn());
  };
  const get = (key: string) => snaps.get(key) ?? EMPTY;
  /** Change one reply by id, or take it out with null. */
  const change = (id: string, to: (r: SentReply, snap: SentSnapshot) => SentReply | null, went = 0) => {
    const key = keyOf.get(id);
    if (key === undefined) return;
    const snap = get(key);
    const replies = snap.replies.flatMap((r) => {
      if (r.id !== id) return [r];
      const out = to(r, snap);
      return out ? [out] : [];
    });
    if (!replies.some((r) => r.id === id)) keyOf.delete(id);
    set(key, { replies, went: snap.went + went });
  };
  return {
    add: (key, text, at) => {
      next += 1;
      const id = `sent-${String(next)}`;
      keyOf.set(id, key);
      const snap = get(key);
      set(key, { ...snap, replies: [...snap.replies, { id, text, at, gone: false, seq: 0 }] });
      return id;
    },
    went: (id) => change(id, (r, snap) => ({ ...r, gone: true, seq: snap.went + 1 }), 1),
    drop: (id) => change(id, () => null),
    settle: (key, went) => {
      const snap = get(key);
      const replies = snap.replies.filter((r) => !(r.gone && r.seq <= went));
      if (replies.length === snap.replies.length) return;
      snap.replies.filter((r) => !replies.includes(r)).forEach((r) => keyOf.delete(r.id));
      set(key, { ...snap, replies });
    },
    get,
    subscribe: (key, fn) => {
      const fns = subs.get(key) ?? new Set();
      fns.add(fn);
      subs.set(key, fns);
      return () => {
        fns.delete(fn);
        if (fns.size === 0) subs.delete(key);
      };
    },
  };
}
