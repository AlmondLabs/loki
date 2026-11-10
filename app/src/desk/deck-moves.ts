import type { Dispatch, SetStateAction } from "react";
import { OUTSIDE_ENDS, type AttentionItem } from "../../../core/attention/model.ts";
import { inLane, type ResolvedLane } from "../../../core/attention/lanes.ts";
import { idOf, popHead, stampOf, type Decision } from "../../../core/attention/queue.ts";
import type { MoveResult, OutsideReplyExtra, OutsideReplyResult } from "../../../core/attention/use-attention.ts";
import type { MailAddressing, ReplyThen } from "../../../core/frame-types.ts";
import { newId } from "../shared/new-id";

/** The picker a card has open in its picker slot: where the thread goes, when the card comes back, or its labels. */
export type PickerKind = "handoff" | "later" | "label";

/** The reply box of an outside card, held by the deck (KTD9) so ⌘], ⌘[ and ⌘E can send what is in it. */
export interface ReplyBox {
  text: string;
  /** How a mail reply is addressed (plan 076); null while the person has not changed it, which sends to all. */
  mail: MailAddressing | null;
  busy: boolean;
  error: string | null;
  /**
   * A mail reply sent alone and still held for its undo (plan 083): the card stays on top, so Z finds the hold here
   * rather than on a decision. Null or absent once it went.
   */
  held?: { outbox_id: string; text: string; mail: MailAddressing | null } | null;
  /**
   * The thread the person opened on a Slack card (plan 085), for the card as it was then (`key`, cardKey): the view
   * shows it, and the reply goes into it. A newer message on the card makes it stale, and the card's own place is used.
   */
  thread?: OpenedThread | null;
}

/** A thread opened on a Slack card (plan 085): the card it was opened on, as cardKey says, and the thread's first message. */
export interface OpenedThread {
  key: string;
  ts: string;
}

/** A card as its thread view knows it: its account, thread and newest message, so a newer message is another card. */
export function cardKey(item: AttentionItem): string {
  const o = item.outside;
  return o ? `${o.account_id}/${o.thread_id}/${o.newest_message_id}` : "";
}

/** The thread a reply on this card goes into (plan 085): the one opened on it as it is now, else none. */
export function openedThreadOf(item: AttentionItem, reply: Pick<ReplyBox, "thread">): string | null {
  const key = cardKey(item);
  return key && reply.thread?.key === key ? reply.thread.ts : null;
}

/** An empty reply box: what a card starts with, and what a sent reply leaves. */
export const EMPTY_REPLY: ReplyBox = { text: "", mail: null, busy: false, error: null };

/**
 * The moves the deck asks of the app (useAttention's, plan 070 U6), with how the press came already filled in. Read,
 * later, archive and label write back out there and resolve to the reason when refused; `seen` and `unread` are an
 * approval's, which moves the card past as it answers.
 */
export interface DeckMoveApi {
  read: (item: AttentionItem) => Promise<MoveResult>;
  later: (item: AttentionItem, until?: string) => Promise<MoveResult>;
  laterAsks: (item: AttentionItem) => boolean;
  archive: (item: AttentionItem) => Promise<string | null>;
  label: (item: AttentionItem, labelIds: string[]) => Promise<string | null>;
  undo: (item: AttentionItem) => Promise<string | null>;
  /** An outside card's reply, sent before the key's own move; absent, outside cards have no reply box. */
  replyOutside?: (item: AttentionItem, text: string, then: ReplyThen, extra?: OutsideReplyExtra) => Promise<OutsideReplyResult>;
  /** Stop a held mail reply before it goes (plan 076); absent, a mail reply goes at once, as a Slack one does. */
  unsendOutside?: (item: AttentionItem, outboxId: string) => Promise<boolean>;
  seen: (item: AttentionItem, via: "approve" | "deny") => void;
  unread: (item: AttentionItem) => void;
  approve: (item: AttentionItem, requestId: string, behavior: "allow" | "deny" | "always") => void;
}

/** What the deck's moves read and write: the card on top, the visit's queue and decisions, the badge's flash, the pickers and the reply box. */
export interface DeckMovesHost {
  current: AttentionItem | undefined;
  /** Every decision this visit, across lane switches; `lane` narrows which one undo takes back. */
  decided: Decision[];
  /** The lane Flow is in on this device, null for Everything (plan 087, KTD6). */
  lane: ResolvedLane | null;
  /** The reply box of the card on top. */
  reply: ReplyBox;
  setReply: (id: string, patch: Partial<ReplyBox>) => void;
  setDecided: Dispatch<SetStateAction<Decision[]>>;
  setQueue: Dispatch<SetStateAction<AttentionItem[]>>;
  say: (word: string) => void;
  setDir: (dir: "next" | "back") => void;
  /** Open a picker on the card on top, or close it with null. */
  pick: (kind: PickerKind | null) => void;
  /** A reply went out this visit. */
  sent: () => void;
  moves: DeckMoveApi;
  /** A new id for a held mail reply (plan 076); a random one when left out, so a test can name its own. */
  newId?: () => string;
}

/** A move a key makes after its reply; a reply sent alone (`stay`, plan 083) makes none. */
type Move = Exclude<ReplyThen, "stay">;

/** The decision each key leaves behind, and how it reads in the visit's summary. */
const DECISION: Record<Move, { action: Decision["action"]; via: NonNullable<Decision["via"]>; word: string }> = {
  read: { action: "seen", via: "next", word: "read" },
  later: { action: "later", via: "later", word: "later" },
  archive: { action: "archived", via: "archive", word: "archived" },
};

/** What a refused move flashes, before the reason. */
const REFUSED: Record<Move, string> = { read: "not marked read", later: "not put off", archive: "not archived" };

/** Whether a card takes labels: an email card only (R12); a chat or a Slack message has none. */
export const takesLabels = (item: AttentionItem | undefined): boolean => item?.outside?.provider === "gmail";

/**
 * The deck's moves on the card on top (plan 070, U7), the same on a chat, an email and a Slack card: read (⌘]), later
 * (⌘[, the second press asks when), archive (⌘E), label (L, email only), undo and approve. A move pops the card at once
 * and re-orders the rest by score (popHead); a write-back that fails out there brings the card back on top with the
 * reason. Text in an outside card's box goes first, with the key's move after it (R11): the card moves only once the
 * reply is sent and the move went, and a sent reply is never sent again. Outside React, so a test drives it with a fake
 * host; the deck builds one each render (useDeckActions).
 */
export function createDeckMoves(host: DeckMovesHost) {
  const { moves } = host;
  const decide = (item: AttentionItem, then: Move) => {
    const { action, via } = DECISION[then];
    host.setDir("next");
    host.setDecided((d) => [...d, { item, action, via, stamp: stampOf(item) }]);
    host.setQueue(popHead);
  };
  /** The card is still where it was: its decision goes and it is back on top. */
  const restore = (item: AttentionItem, action: Decision["action"]) => {
    host.setDecided((d) => d.filter((x) => !(x.item === item && x.action === action)));
    host.setQueue((q) => [item, ...q.filter((i) => idOf(i) !== idOf(item))]);
  };
  /** Text waits in an outside card's box: the key sends it, then makes its move. */
  const hasReply = (item: AttentionItem) => !!item.outside && !!moves.replyOutside && host.reply.text.trim() !== "";

  /**
   * A mail reply (plan 076): the card moves on at once and the reply is held for its undo, which Z takes back while it
   * waits (`held` on its decision). A send that fails brings the card back on top with the words and the reason; a move
   * after it that fails brings it back with the reason, the reply sent.
   */
  const sendHeld = async (item: AttentionItem, then: Move, send: NonNullable<DeckMoveApi["replyOutside"]>): Promise<void> => {
    const id = idOf(item);
    const { text, mail } = host.reply;
    const outbox = host.newId?.() ?? newId();
    const { action, via } = DECISION[then];
    const mine = (d: Decision) => d.held?.outbox_id === outbox;
    host.setReply(id, { text: "", mail: null, error: null });
    host.setDir("next");
    host.setDecided((d) => [...d, { item, action, via, stamp: stampOf(item), held: { outbox_id: outbox, text, mail } }]);
    host.setQueue(popHead);
    host.say("sending · z undo");
    const r = await send(item, text, then, { mail, outbox_id: outbox });
    // Undo stopped it and already put the card and the words back.
    if (r.undone) return;
    if (r.sent) host.sent();
    if (r.sent && !r.error) {
      // Sent: from here undo takes back the key's move, as for any card.
      host.setDecided((d) => d.map((x) => (mine(x) ? { item: x.item, action: x.action, via: x.via, stamp: x.stamp } : x)));
      host.say("sent");
      return;
    }
    host.setDecided((d) => d.filter((x) => !mine(x)));
    host.setQueue((q) => [item, ...q.filter((i) => idOf(i) !== id)]);
    if (r.sent) {
      host.setReply(id, { error: r.error });
      host.say(`sent, ${REFUSED[then]}`);
    } else {
      host.setReply(id, { text, mail, error: r.error });
      host.say("not sent");
    }
  };

  /**
   * A mail reply sent alone (plan 083): held for its undo like any mail reply, while the card stays on top for the
   * person's own next move. Z stops it while it waits and puts the words back; a send that fails puts them back too.
   */
  const sendHeldStay = async (item: AttentionItem, send: NonNullable<DeckMoveApi["replyOutside"]>): Promise<void> => {
    const id = idOf(item);
    const { text, mail } = host.reply;
    const outbox = host.newId?.() ?? crypto.randomUUID();
    host.setReply(id, { text: "", mail: null, error: null, held: { outbox_id: outbox, text, mail } });
    host.say("sending · z undo");
    const r = await send(item, text, "stay", { mail, outbox_id: outbox });
    // Undo stopped it and already put the words back.
    if (r.undone) return;
    if (r.sent) {
      host.setReply(id, { held: null });
      host.sent();
      host.say("sent");
      return;
    }
    host.setReply(id, { text, mail, error: r.error, held: null });
    host.say("not sent");
  };

  /** Send the box's text, then the key's move; the card moves on only when both went, and keeps the error when not. */
  const sendThen = async (item: AttentionItem, then: ReplyThen): Promise<void> => {
    const send = moves.replyOutside;
    const id = idOf(item);
    if (!send || host.reply.busy) return;
    if (item.outside?.provider === "gmail" && moves.unsendOutside) return then === "stay" ? sendHeldStay(item, send) : sendHeld(item, then, send);
    host.setReply(id, { busy: true, error: null });
    let r: OutsideReplyResult;
    try {
      const threadTs = openedThreadOf(item, host.reply);
      r = await send(item, host.reply.text, then, { mail: host.reply.mail, ...(threadTs ? { thread_ts: threadTs } : {}) });
    } finally {
      host.setReply(id, { busy: false });
    }
    if (r.sent) {
      host.setReply(id, { text: "", mail: null });
      host.sent();
    }
    if (r.error) {
      // The reply went but its move did not, or nothing went: the card stays, saying why.
      host.setReply(id, { error: r.error });
      if (r.sent) host.say("sent");
      return;
    }
    if (!r.sent) return;
    if (then === "stay") {
      host.say("sent");
      return;
    }
    decide(item, then);
    host.say(DECISION[then].word);
  };

  /** Read (⌘], →): marked read here and out there; the card rests and comes back later. */
  const read = () => {
    const item = host.current;
    if (!item || host.reply.busy) return;
    if (hasReply(item)) return void sendThen(item, "read");
    decide(item, "read");
    host.say("read");
    void moves.read(item).then((r) => {
      if (!r.error) return;
      restore(item, "seen");
      host.say(`${REFUSED.read}: ${r.error}`);
    });
  };

  /** Later (⌘[, ←): left unread here and out there, back in a day; the second press in a row asks when (R7). */
  const later = () => {
    const item = host.current;
    if (!item || host.reply.busy) return;
    if (hasReply(item)) return void sendThen(item, "later");
    if (moves.laterAsks(item)) return host.pick("later");
    decide(item, "later");
    host.say("later");
    void moves.later(item).then((r) => {
      if (r.error) {
        restore(item, "later");
        host.say(`${REFUSED.later}: ${r.error}`);
      } else if (r.ask) {
        // The card's rest moved under the press: it asks after all.
        restore(item, "later");
        host.pick("later");
      }
    });
  };

  /** The return time picked for the second later (ISO): the card rests until then. */
  const pickLater = (until: string) => {
    const item = host.current;
    if (!item) return;
    host.pick(null);
    decide(item, "later");
    host.say("later");
    void moves.later(item, until).then((r) => {
      if (!r.error) return;
      restore(item, "later");
      host.say(`${REFUSED.later}: ${r.error}`);
    });
  };

  /**
   * Archive (⌘E, E): done with the card. A main chat cannot be archived, nor a Jira card, which ends only with read
   * (KTD12); the card stays, says so, and any text in its box stays unsent. An outside card's thread is archived in its
   * account (Slack: read), and a refusal there brings the card back the same way.
   */
  const archive = () => {
    const item = host.current;
    if (!item || host.reply.busy) return;
    if (!item.outside && item.id === "default") return host.say("main chats stay");
    if (item.outside && !OUTSIDE_ENDS[item.outside.provider].archive) return host.say("a jira card ends with read");
    if (hasReply(item)) return void sendThen(item, "archive");
    decide(item, "archive");
    host.say("archived");
    void moves.archive(item).then((err) => {
      if (!err) return;
      restore(item, "archived");
      host.say(`${REFUSED.archive}: ${err}`);
    });
  };

  /** L: open the label picker on an email card; on any other card it does nothing. */
  const label = () => {
    if (takesLabels(host.current)) host.pick("label");
  };

  /** The labels picked for the card on top: added in Gmail, and the card stays for the next key (R12). Resolves to the reason, or null. */
  const pickLabels = async (labelIds: string[]): Promise<string | null> => {
    const item = host.current;
    if (!item) return null;
    const err = await moves.label(item, labelIds);
    if (err) return err;
    host.pick(null);
    host.setDecided((d) => [...d, { item, action: "label", via: "label", stamp: stampOf(item) }]);
    host.say("labelled");
    return null;
  };

  /** Back on top as it was before its last move. */
  const back = (last: Decision) => {
    host.setDir("back");
    host.setDecided((d) => d.filter((x) => x !== last));
    host.setQueue((q) => [last.item, ...q.filter((i) => idOf(i) !== idOf(last.item))]);
  };

  /**
   * Undo (⌘Z, Z): the last move of this visit on a card in the active lane is taken back, out there too (R14). A move
   * made on a card another lane holds waits until the person is back in a lane that holds it (KTD6).
   */
  const undo = () => {
    // A mail reply sent alone and still held (plan 083): stopped before it goes, and the words come back to the box.
    const waiting = host.reply.held;
    const here = host.current;
    if (waiting && here && moves.unsendOutside) {
      void moves.unsendOutside(here, waiting.outbox_id).then((stopped) => {
        if (!stopped) return host.say("already sent");
        host.setReply(idOf(here), { text: waiting.text, mail: waiting.mail, error: null, held: null });
        host.say("not sent");
      });
      return;
    }
    const { lane } = host;
    let at = host.decided.length - 1;
    while (at >= 0 && lane && !inLane(host.decided[at].item, lane)) at--;
    const last = at >= 0 ? host.decided[at] : undefined;
    if (!last) return;
    // A mail reply still held (plan 076): stopped before it goes, and the card comes back with the words in its box.
    const held = last.held;
    if (held && moves.unsendOutside) {
      void moves.unsendOutside(last.item, held.outbox_id).then((stopped) => {
        if (!stopped) return host.say("already sent");
        back(last);
        host.setReply(idOf(last.item), { text: held.text, mail: held.mail, error: null });
        host.say("not sent");
      });
      return;
    }
    // An approval's move only marked the chat seen; the answer itself stays given.
    if (last.via === "approve" || last.via === "deny") {
      moves.unread(last.item);
      return back(last);
    }
    void moves.undo(last.item).then((err) => {
      if (err === "handed off") host.say("handed off: not undone");
      else if (err) host.say(`not undone: ${err}`);
      else back(last);
    });
  };

  /** Approve or deny the card's request: answered, and the card moves past for this visit. */
  const approve = (behavior: "allow" | "deny" | "always") => {
    const item = host.current;
    if (!item?.pendingApproval) return;
    const via = behavior !== "deny" ? "approve" : "deny";
    moves.approve(item, item.pendingApproval.requestId, behavior);
    moves.seen(item, via);
    host.setDir("next");
    host.setDecided((d) => [...d, { item, action: "seen", via, stamp: stampOf(item) }]);
    host.setQueue(popHead);
    host.say(behavior !== "deny" ? "approved" : "denied");
  };

  /**
   * Enter in a Slack card's box, ⌘Enter in a mail's, or the send button: the reply goes alone, and the card stays where
   * it is for the person's own next move (plan 083).
   */
  const sendReply = () => {
    const item = host.current;
    if (item && hasReply(item)) void sendThen(item, "stay");
  };

  return { read, later, pickLater, archive, label, pickLabels, undo, approve, sendReply };
}

/** The deck's moves, as `createDeckMoves` makes them. */
export type DeckMoves = ReturnType<typeof createDeckMoves>;
