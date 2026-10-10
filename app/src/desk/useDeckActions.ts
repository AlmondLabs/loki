import { useState, type Dispatch, type SetStateAction } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import { popHead, stampOf, type Decision } from "../../../core/attention/queue.ts";

/**
 * What moves a card, and the small state those moves leave behind: the 900ms flash on the badge
 * ("approved", "denied", "sent", "archived"), the count of replies this visit, and which way the last move
 * went so the next card enters from that side. Two ways past a card: Next marks the chat read and moves on
 * (the chat stays in the Inbox for your next visit), Archive is done (the chat leaves the Inbox). The reply
 * box itself is the Conversation's. The queue and the decisions are the deck's (useDeckQueue); this hook only
 * writes to them. Every move pops the head and re-orders the rest by score at that moment (popHead), the way
 * a scheduler picks its next process when one leaves the CPU.
 */
export function useDeckActions({
  current,
  decided,
  setDecided,
  setQueue,
  onSeen,
  onUnread,
  onArchive,
  onUnarchive,
  onApprove,
  agent = null,
}: {
  current: AttentionItem | undefined;
  decided: Decision[];
  setDecided: Dispatch<SetStateAction<Decision[]>>;
  setQueue: Dispatch<SetStateAction<AttentionItem[]>>;
  /** Marked read on the way past; `via` says what moved it (an approval moves the card too, and is logged as one). */
  onSeen: (item: AttentionItem, via: "next" | "approve" | "deny") => void;
  onUnread: (item: AttentionItem) => void;
  /** Archive the chat (done); resolves to an error or null. */
  onArchive: (item: AttentionItem) => Promise<string | null>;
  onUnarchive: (item: AttentionItem) => void;
  onApprove: (item: AttentionItem, requestId: string, behavior: "allow" | "deny") => void;
  /** The agent pill on, if one is: undo takes back that agent's last decision, the one you can see. */
  agent?: string | null;
}) {
  const [flash, setFlash] = useState<string | null>(null);
  /** Replies and answers sent this visit. A reply keeps you on the card; only next/archive/approve/deny move it. */
  const [replies, setReplies] = useState(0);
  /** Which way the last move went; the next card enters from that side. */
  const [dir, setDir] = useState<"next" | "back">("next");

  const say = (word: string) => {
    setFlash(word);
    setTimeout(() => setFlash(null), 900);
  };
  const decide = (item: AttentionItem, action: Decision["action"], via: NonNullable<Decision["via"]>) => {
    setDir("next");
    setDecided((d) => [...d, { item, action, via, stamp: stampOf(item) }]);
    setQueue(popHead);
  };
  /** Next: read, move on; the chat comes back on a later visit, or in this one if it moves on. */
  const next = (via: "next" | "approve" | "deny" = "next") => {
    if (!current) return;
    onSeen(current, via);
    decide(current, "seen", via);
  };
  /** Archive: done with the chat. A main chat cannot be archived; the card stays and says so. */
  const archive = () => {
    const item = current;
    if (!item) return;
    if (item.id === "default") return say("main chats stay");
    decide(item, "archived", "archive");
    void onArchive(item).then((err) => {
      if (!err) return;
      // The daemon refused: the chat is still live, so it comes back on top with the reason.
      setDecided((d) => d.filter((x) => !(x.item === item && x.action === "archived")));
      setQueue((q) => [item, ...q]);
      say("not archived");
    });
    say("archived");
  };
  /**
   * A reply or an answer went out: the card stays — you may want to watch the answer arrive, and a
   * follow-up typed while it streams in lands while the conversation's prompt is still cached. Moving on
   * is yours (⌘]); if you do, the answer brings the card back by score, new and in focus, behind whatever
   * you are reading then. Sending already marks the conversation seen.
   */
  const sent = () => {
    setReplies((n) => n + 1);
    say("sent");
  };
  const undo = () => {
    let at = decided.length - 1;
    while (at >= 0 && agent && decided[at].item.agentId !== agent) at--;
    const last = decided[at];
    if (!last) return;
    if (last.action === "seen") onUnread(last.item);
    else onUnarchive(last.item);
    setDir("back");
    setDecided((d) => d.filter((_, i) => i !== at));
    setQueue((q) => [last.item, ...q]);
  };
  const approve = (behavior: "allow" | "deny") => {
    if (!current?.pendingApproval) return;
    onApprove(current, current.pendingApproval.requestId, behavior);
    say(behavior === "allow" ? "approved" : "denied");
    next(behavior === "allow" ? "approve" : "deny");
  };
  return { flash, replies, dir, next, archive, undo, approve, sent };
}
