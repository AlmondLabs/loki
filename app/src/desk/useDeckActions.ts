import { useState, type Dispatch, type SetStateAction } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import { popHead, stampOf, type Decision } from "../../../core/attention/queue.ts";

/**
 * What moves a card, and the small state those moves leave behind: the 900ms flash on the badge
 * ("approved", "denied", "sent"), the count of replies this pass, and which way the last move went so
 * the next card enters from that side. The reply box itself is the Conversation's. The queue and the
 * decisions are the deck's (useDeckQueue); this hook only writes to them. Every move pops the head and
 * re-orders the rest by score at that moment (popHead), the way a scheduler picks its next process
 * when one leaves the CPU.
 */
export function useDeckActions({
  current,
  decided,
  setDecided,
  setQueue,
  snoozedShown,
  onSeen,
  onUnread,
  onLater,
  onUnsnooze,
  onApprove,
}: {
  current: AttentionItem | undefined;
  decided: Decision[];
  setDecided: Dispatch<SetStateAction<Decision[]>>;
  setQueue: Dispatch<SetStateAction<AttentionItem[]>>;
  /** The deck's "show snoozed" state, stamped on each decision (see Decision.snoozedShown). */
  snoozedShown: boolean;
  onSeen: (item: AttentionItem) => void;
  onUnread: (item: AttentionItem) => void;
  onLater: (item: AttentionItem) => void;
  onUnsnooze: (item: AttentionItem) => void;
  onApprove: (item: AttentionItem, requestId: string, behavior: "allow" | "deny") => void;
}) {
  const [flash, setFlash] = useState<string | null>(null);
  /** Replies and answers sent this pass. A reply keeps you on the card; only next/later/approve/deny move it. */
  const [replies, setReplies] = useState(0);
  /** Which way the last move went; the next card enters from that side. */
  const [dir, setDir] = useState<"next" | "back">("next");

  const advance = (action: "seen" | "unread", via: Decision["via"] = action === "seen" ? "next" : "later") => {
    if (!current) return;
    if (action === "seen") onSeen(current);
    else {
      onUnread(current);
      if (!current.pendingApproval) onLater(current); // approvals never snooze
    }
    setDir("next");
    setDecided((d) => [...d, { item: current, action, via, stamp: stampOf(current), snoozedShown }]);
    setQueue(popHead);
  };
  /**
   * A reply or an answer went out: the card stays — you may want to watch the answer arrive, and a
   * follow-up typed while it streams in lands while the conversation's prompt is still cached. Moving on
   * is yours (→ / ⌘]); if you do move on, the answer brings the card back by score, warm and yours, behind
   * whatever you are reading then. Sending already marks the conversation seen.
   */
  const sent = () => {
    setReplies((n) => n + 1);
    setFlash("sent");
    setTimeout(() => setFlash(null), 900);
  };
  const undo = () => {
    const last = decided[decided.length - 1];
    if (!last) return;
    if (last.action === "seen") onUnread(last.item);
    else onUnsnooze(last.item);
    setDir("back");
    setDecided((d) => d.slice(0, -1));
    setQueue((q) => [last.item, ...q]);
  };
  const approve = (behavior: "allow" | "deny") => {
    if (!current?.pendingApproval) return;
    onApprove(current, current.pendingApproval.requestId, behavior);
    setFlash(behavior === "allow" ? "approved" : "denied");
    setTimeout(() => setFlash(null), 900);
    advance("seen", behavior === "allow" ? "approve" : "deny");
  };
  return { flash, replies, dir, advance, undo, approve, sent };
}
