export interface SentReply {
  id: string;
  text: string;
  at: string;
  gone: boolean;
  seq: number;
}

export interface SentSnapshot {
  replies: readonly SentReply[];
  went: number;
}

export const sentKey = (accountId: string, threadId: string, opened: string | null = null): string => `${accountId}\u0000${threadId}\u0000${opened ?? ""}`;

const EMPTY: SentSnapshot = Object.freeze({ replies: [], went: 0 });

export interface SentReplies {
  add: (key: string, text: string, at: string) => string;
  went: (id: string) => void;
  drop: (id: string) => void;
  settle: (key: string, went: number) => void;
  get: (key: string) => SentSnapshot;
  subscribe: (key: string, fn: () => void) => () => void;
}

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
