import type { Dispatch, SetStateAction } from "react";
import { ownerAgentOf, type AttentionItem } from "../../../core/attention/model.ts";
import { idOf, popHead, stampOf, type Decision } from "../../../core/attention/queue.ts";
import type { MoveResult, OutsideReplyResult } from "../../../core/attention/use-attention.ts";
import type { ReplyThen } from "../../../core/frame-types.ts";

/** The picker a card has open in its picker slot: where the thread goes, when the card comes back, or its labels. */
export type PickerKind = "handoff" | "later" | "label";

/** The reply box of an outside card, held by the deck (KTD9) so ⌘], ⌘[ and ⌘E can send what is in it. */
export interface ReplyBox {
  text: string;
  busy: boolean;
  error: string | null;
}

/** An empty reply box: what a card starts with, and what a sent reply leaves. */
export const EMPTY_REPLY: ReplyBox = { text: "", busy: false, error: null };

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
  replyOutside?: (item: AttentionItem, text: string, then: ReplyThen) => Promise<OutsideReplyResult>;
  seen: (item: AttentionItem, via: "approve" | "deny") => void;
  unread: (item: AttentionItem) => void;
  approve: (item: AttentionItem, requestId: string, behavior: "allow" | "deny" | "always") => void;
}

/** What the deck's moves read and write: the card on top, the visit's queue and decisions, the badge's flash, the pickers and the reply box. */
export interface DeckMovesHost {
  current: AttentionItem | undefined;
  /** Every decision this visit; `agent` narrows which one undo takes back. */
  decided: Decision[];
  agent: string | null;
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
}

/** The decision each key leaves behind, and how it reads in the visit's summary. */
const DECISION: Record<ReplyThen, { action: Decision["action"]; via: NonNullable<Decision["via"]>; word: string }> = {
  read: { action: "seen", via: "next", word: "read" },
  later: { action: "later", via: "later", word: "later" },
  archive: { action: "archived", via: "archive", word: "archived" },
};

/** What a refused move flashes, before the reason. */
const REFUSED: Record<ReplyThen, string> = { read: "not marked read", later: "not put off", archive: "not archived" };

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
  const decide = (item: AttentionItem, then: ReplyThen) => {
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

  /** Send the box's text, then the key's move; the card moves on only when both went, and keeps the error when not. */
  const sendThen = async (item: AttentionItem, then: ReplyThen): Promise<void> => {
    const send = moves.replyOutside;
    const id = idOf(item);
    if (!send || host.reply.busy) return;
    host.setReply(id, { busy: true, error: null });
    let r: OutsideReplyResult;
    try {
      r = await send(item, host.reply.text, then);
    } finally {
      host.setReply(id, { busy: false });
    }
    if (r.sent) {
      host.setReply(id, { text: "" });
      host.sent();
    }
    if (r.error) {
      // The reply went but its move did not, or nothing went: the card stays, saying why.
      host.setReply(id, { error: r.error });
      if (r.sent) host.say("sent");
      return;
    }
    if (!r.sent) return;
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
   * Archive (⌘E, E): done with the card. A main chat cannot be archived; the card stays and says so. An outside card's
   * thread is archived in its account (Slack: read), and a refusal there brings the card back the same way.
   */
  const archive = () => {
    const item = host.current;
    if (!item || host.reply.busy) return;
    if (!item.outside && item.id === "default") return host.say("main chats stay");
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

  /** Undo (⌘Z, Z): the last move of this visit (the pill's agent's, when one is on) is taken back, out there too (R14). */
  const undo = () => {
    let at = host.decided.length - 1;
    while (at >= 0 && host.agent && ownerAgentOf(host.decided[at].item) !== host.agent) at--;
    const last = at >= 0 ? host.decided[at] : undefined;
    if (!last) return;
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

  /** Enter in an outside card's box, or its send button: the reply goes, and the card is read (R11). */
  const sendReply = () => {
    const item = host.current;
    if (item && hasReply(item)) void sendThen(item, "read");
  };

  return { read, later, pickLater, archive, label, pickLabels, undo, approve, sendReply };
}

/** The deck's moves, as `createDeckMoves` makes them. */
export type DeckMoves = ReturnType<typeof createDeckMoves>;
