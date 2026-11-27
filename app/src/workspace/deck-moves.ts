import type { Dispatch, SetStateAction } from "react";
import { OUTSIDE_ENDS, type AttentionItem } from "../../../core/attention/model.ts";
import { inLane, type ResolvedLane } from "../../../core/attention/lanes.ts";
import { idOf, stampOf, type Decision } from "../../../core/attention/queue.ts";
import type { MoveResult, OutsideReplyExtra, OutsideReplyResult } from "../../../core/attention/use-attention.ts";
import type { MailAddressing, ReplyThen } from "../../../core/frame-types.ts";
import { newId } from "../shared/new-id";
import { isMainChat } from "../../../core/chat-scope.ts";

export type PickerKind = "handoff" | "later" | "label";

export interface ReplyBox {
  text: string;
  mail: MailAddressing | null;
  busy: boolean;
  error: string | null;
  held?: { outbox_id: string; text: string; mail: MailAddressing | null } | null;
  thread?: OpenedThread | null;
}

export interface OpenedThread {
  key: string;
  ts: string;
}

export function cardKey(item: AttentionItem): string {
  const o = item.outside;
  return o ? `${o.account_id}/${o.thread_id}` : "";
}

export function openedThreadOf(item: AttentionItem, reply: Pick<ReplyBox, "thread">): string | null {
  const key = cardKey(item);
  return key && reply.thread?.key === key ? reply.thread.ts : null;
}

export const EMPTY_REPLY: ReplyBox = { text: "", mail: null, busy: false, error: null };

export interface DeckMoveApi {
  read: (item: AttentionItem) => Promise<MoveResult>;
  later: (item: AttentionItem, until?: string) => Promise<MoveResult>;
  laterAsks: (item: AttentionItem) => boolean;
  archive: (item: AttentionItem) => Promise<string | null>;
  label: (item: AttentionItem, labelIds: string[]) => Promise<string | null>;
  undo: (item: AttentionItem) => Promise<string | null>;
  replyOutside?: (item: AttentionItem, text: string, then: ReplyThen, extra?: OutsideReplyExtra) => Promise<OutsideReplyResult>;
  unsendOutside?: (item: AttentionItem, outboxId: string) => Promise<boolean>;
  seen: (item: AttentionItem, via: "approve" | "deny") => void;
  unread: (item: AttentionItem) => void;
  approve: (item: AttentionItem, requestId: string, behavior: "allow" | "deny" | "always") => void;
}

export function rowAfter(rows: readonly AttentionItem[], id: string): string | null {
  const at = rows.findIndex((i) => idOf(i) === id);
  if (at < 0) return null;
  const to = at + 1 < rows.length ? at + 1 : at - 1;
  return to >= 0 ? idOf(rows[to]) : null;
}

export function placeAt(rows: readonly AttentionItem[], item: AttentionItem, at: number): AttentionItem[] {
  const rest = rows.filter((i) => idOf(i) !== idOf(item));
  const to = Math.max(0, Math.min(at, rest.length));
  return [...rest.slice(0, to), item, ...rest.slice(to)];
}

export interface DeckMovesHost {
  selected: () => AttentionItem | undefined;
  queue: AttentionItem[];
  select: (id: string | null) => void;
  decided: Decision[];
  lane: ResolvedLane | null;
  replyOf: (id: string) => ReplyBox;
  setReply: (id: string, patch: Partial<ReplyBox>) => void;
  setSending: (id: string, on: boolean) => void;
  setDecided: Dispatch<SetStateAction<Decision[]>>;
  setQueue: Dispatch<SetStateAction<AttentionItem[]>>;
  say: (word: string) => void;
  notice?: (item: AttentionItem, words: string) => void;
  setDir: (dir: "next" | "back") => void;
  pick: (id: string, kind: PickerKind | null) => void;
  sent: () => void;
  moves: DeckMoveApi;
  newId?: () => string;
}

type Move = Exclude<ReplyThen, "stay">;

const DECISION: Record<Move, { action: Decision["action"]; via: NonNullable<Decision["via"]>; word: string }> = {
  read: { action: "seen", via: "next", word: "Read" },
  later: { action: "later", via: "later", word: "Later" },
  archive: { action: "archived", via: "archive", word: "Archived" },
};

const REFUSED: Record<Move, string> = { read: "Not marked read", later: "Not put off", archive: "Not archived" };

export const needsSignIn = (item: AttentionItem | undefined): boolean => {
  const cause = item?.outside?.disconnected;
  return !!cause && cause !== "temporarily_failing";
};

export const takesLabels = (item: AttentionItem | undefined): boolean => item?.outside?.provider === "gmail";

export function createDeckMoves(host: DeckMovesHost) {
  const { moves } = host;
  const rowOf = (item: AttentionItem) =>
    Math.max(
      0,
      host.queue.findIndex((i) => idOf(i) === idOf(item)),
    );
  const leave = (item: AttentionItem) => {
    const id = idOf(item);
    const now = host.selected();
    if (now && idOf(now) === id) host.select(rowAfter(host.queue, id));
    host.setQueue((q) => q.filter((i) => idOf(i) !== id));
  };
  const putBack = (item: AttentionItem, at: number) => {
    host.setQueue((q) => placeAt(q, item, at));
    host.select(idOf(item));
  };
  const decide = (item: AttentionItem, then: Move): number => {
    const { action, via } = DECISION[then];
    const at = rowOf(item);
    host.setDir("next");
    host.setDecided((d) => [...d, { item, action, via, stamp: stampOf(item), at }]);
    leave(item);
    return at;
  };
  const refuse = (item: AttentionItem, words: string) => (host.notice ? host.notice(item, words) : host.say(words));
  const restore = (item: AttentionItem, action: Decision["action"], at: number) => {
    host.setDecided((d) => d.filter((x) => !(x.item === item && x.action === action)));
    putBack(item, at);
  };
  const replyOf = (item: AttentionItem) => host.replyOf(idOf(item));
  const hasReply = (item: AttentionItem) => !!item.outside && !!moves.replyOutside && replyOf(item).text.trim() !== "";

  const sendHeld = async (item: AttentionItem, then: Move, send: NonNullable<DeckMoveApi["replyOutside"]>): Promise<void> => {
    const id = idOf(item);
    const { text, mail } = replyOf(item);
    const outbox = host.newId?.() ?? newId();
    const { action, via } = DECISION[then];
    const mine = (d: Decision) => d.held?.outbox_id === outbox;
    const at = rowOf(item);
    host.setReply(id, { text: "", mail: null, error: null });
    host.setDir("next");
    host.setDecided((d) => [...d, { item, action, via, stamp: stampOf(item), at, held: { outbox_id: outbox, text, mail } }]);
    leave(item);
    host.say("Sending · z undo");
    const r = await send(item, text, then, { mail, outbox_id: outbox });
    if (r.undone) return;
    if (r.sent) host.sent();
    if (r.sent && !r.error) {
      host.setDecided((d) => d.map((x) => (mine(x) ? { item: x.item, action: x.action, via: x.via, stamp: x.stamp, at: x.at } : x)));
      host.say("Sent");
      return;
    }
    host.setDecided((d) => d.filter((x) => !mine(x)));
    putBack(item, at);
    if (r.sent) {
      host.setReply(id, { error: r.error });
      host.say(`Sent, ${REFUSED[then].toLowerCase()}`);
    } else {
      host.setReply(id, { text, mail, error: r.error });
      host.say("Not sent");
    }
  };

  const sendHeldStay = async (item: AttentionItem, send: NonNullable<DeckMoveApi["replyOutside"]>): Promise<void> => {
    const id = idOf(item);
    const { text, mail } = replyOf(item);
    const outbox = host.newId?.() ?? newId();
    host.setReply(id, { text: "", mail: null, error: null, held: { outbox_id: outbox, text, mail } });
    host.say("Sending · z undo");
    const r = await send(item, text, "stay", { mail, outbox_id: outbox });
    if (r.undone) return;
    if (r.sent) {
      host.setReply(id, { held: null });
      host.sent();
      host.say("Sent");
      return;
    }
    host.setReply(id, { text, mail, error: r.error, held: null });
    host.say("Not sent");
  };

  const sendThen = async (item: AttentionItem, then: ReplyThen): Promise<void> => {
    const send = moves.replyOutside;
    const id = idOf(item);
    const box = replyOf(item);
    if (!send || box.busy) return;
    if (item.outside?.provider === "gmail" && moves.unsendOutside) return then === "stay" ? sendHeldStay(item, send) : sendHeld(item, then, send);
    host.setSending(id, true);
    host.setReply(id, { error: null });
    let r: OutsideReplyResult;
    try {
      const threadTs = openedThreadOf(item, box);
      r = await send(item, box.text, then, { mail: box.mail, ...(threadTs ? { thread_ts: threadTs } : {}) });
    } finally {
      host.setSending(id, false);
    }
    if (r.sent) {
      host.setReply(id, { text: "", mail: null });
      host.sent();
    }
    if (r.error) {
      host.setReply(id, { error: r.error });
      if (r.sent) host.say("Sent");
      return;
    }
    if (!r.sent) return;
    if (then === "stay") {
      host.say("Sent");
      return;
    }
    decide(item, then);
    host.say(DECISION[then].word);
  };

  const read = () => {
    const item = host.selected();
    if (!item || replyOf(item).busy) return;
    if (hasReply(item)) return void sendThen(item, "read");
    const at = decide(item, "read");
    host.say("Read");
    void moves.read(item).then((r) => {
      if (!r.error) return;
      restore(item, "seen", at);
      refuse(item, `${REFUSED.read}: ${r.error}`);
    });
  };

  const later = () => {
    const item = host.selected();
    if (!item || replyOf(item).busy) return;
    if (hasReply(item)) return void sendThen(item, "later");
    if (needsSignIn(item)) {
      decide(item, "later");
      host.say("Later");
      refuse(item, "Skipped for this visit: nothing changed in its account");
      return;
    }
    if (moves.laterAsks(item)) return host.pick(idOf(item), "later");
    const at = decide(item, "later");
    host.say("Later");
    void moves.later(item).then((r) => {
      if (r.error) {
        restore(item, "later", at);
        refuse(item, `${REFUSED.later}: ${r.error}`);
      } else if (r.ask) {
        restore(item, "later", at);
        host.pick(idOf(item), "later");
      }
    });
  };

  const pickLater = (until: string) => {
    const item = host.selected();
    if (!item) return;
    host.pick(idOf(item), null);
    const at = decide(item, "later");
    host.say("Later");
    void moves.later(item, until).then((r) => {
      if (!r.error) return;
      restore(item, "later", at);
      refuse(item, `${REFUSED.later}: ${r.error}`);
    });
  };

  const archive = () => {
    const item = host.selected();
    if (!item || replyOf(item).busy) return;
    if (!item.outside && isMainChat(item.id)) return host.say("Main chats stay");
    if (item.outside && !OUTSIDE_ENDS[item.outside.provider].archive) return host.say("A Jira card ends with read");
    if (hasReply(item)) return void sendThen(item, "archive");
    const at = decide(item, "archive");
    host.say("Archived");
    void moves.archive(item).then((err) => {
      if (!err) return;
      restore(item, "archived", at);
      refuse(item, `${REFUSED.archive}: ${err}`);
    });
  };

  const label = () => {
    const item = host.selected();
    if (item && takesLabels(item)) host.pick(idOf(item), "label");
  };

  const pickLabels = async (labelIds: string[]): Promise<string | null> => {
    const item = host.selected();
    if (!item) return null;
    const err = await moves.label(item, labelIds);
    if (err) return err;
    host.pick(idOf(item), null);
    host.setDecided((d) => [...d, { item, action: "label", via: "label", stamp: stampOf(item) }]);
    host.say("Labelled");
    return null;
  };

  const back = (last: Decision) => {
    host.setDir("back");
    host.setDecided((d) => d.filter((x) => x !== last));
    putBack(last.item, last.at ?? 0);
  };

  const undo = () => {
    const here = host.selected();
    const waiting = here ? replyOf(here).held : null;
    if (waiting && here && moves.unsendOutside) {
      void moves.unsendOutside(here, waiting.outbox_id).then((stopped) => {
        if (!stopped) return host.say("Already sent");
        host.setReply(idOf(here), { text: waiting.text, mail: waiting.mail, error: null, held: null });
        host.say("Not sent");
      });
      return;
    }
    const { lane } = host;
    let at = host.decided.length - 1;
    while (at >= 0 && lane && !inLane(host.decided[at].item, lane)) at--;
    const last = at >= 0 ? host.decided[at] : undefined;
    if (!last) return;
    const held = last.held;
    if (held && moves.unsendOutside) {
      void moves.unsendOutside(last.item, held.outbox_id).then((stopped) => {
        if (!stopped) return host.say("Already sent");
        back(last);
        host.setReply(idOf(last.item), { text: held.text, mail: held.mail, error: null });
        host.say("Not sent");
      });
      return;
    }
    if (last.via === "approve" || last.via === "deny") {
      moves.unread(last.item);
      return back(last);
    }
    void moves.undo(last.item).then((err) => {
      if (err === "handed off") host.say("Handed off: not undone");
      else if (err) host.say(`Not undone: ${err}`);
      else back(last);
    });
  };

  const approve = (behavior: "allow" | "deny" | "always") => {
    const item = host.selected();
    if (!item?.pendingApproval) return;
    const via = behavior !== "deny" ? "approve" : "deny";
    moves.approve(item, item.pendingApproval.requestId, behavior);
    moves.seen(item, via);
    host.setDir("next");
    host.setDecided((d) => [...d, { item, action: "seen", via, stamp: stampOf(item), at: rowOf(item) }]);
    leave(item);
    host.say(behavior !== "deny" ? "Approved" : "Denied");
  };

  const sendReply = () => {
    const item = host.selected();
    if (item && hasReply(item)) void sendThen(item, "stay");
  };

  return { read, later, pickLater, archive, label, pickLabels, undo, approve, sendReply };
}

export type DeckMoves = ReturnType<typeof createDeckMoves>;
