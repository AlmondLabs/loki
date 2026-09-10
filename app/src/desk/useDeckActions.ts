import { useState, type Dispatch, type SetStateAction } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import type { ImageAttachment } from "../../../core/attention/content.ts";
import { stampOf, type Decision } from "../../../core/attention/queue.ts";

/**
 * What a card can do, and the small state those actions leave behind: the reply draft and its images,
 * the 900ms flash on the badge ("approved", "sent"), the count of replies this pass, and which way the
 * last move went so the next card enters from that side. The queue and the decisions are the deck's
 * (useDeckQueue); this hook only writes to them.
 */
export function useDeckActions({
  current,
  decided,
  setDecided,
  setQueue,
  onSeen,
  onUnread,
  onLater,
  onUnsnooze,
  onApprove,
  onAnswer,
  onReply,
}: {
  current: AttentionItem | undefined;
  decided: Decision[];
  setDecided: Dispatch<SetStateAction<Decision[]>>;
  setQueue: Dispatch<SetStateAction<AttentionItem[]>>;
  onSeen: (item: AttentionItem) => void;
  onUnread: (item: AttentionItem) => void;
  onLater: (item: AttentionItem) => void;
  onUnsnooze: (item: AttentionItem) => void;
  onApprove: (item: AttentionItem, requestId: string, behavior: "allow" | "deny") => void;
  onAnswer: (item: AttentionItem, requestId: string, answers: Record<string, string | string[]>) => void;
  onReply: (item: AttentionItem, text: string, images?: ImageAttachment[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [flash, setFlash] = useState<string | null>(null);
  /** Replies sent this pass. A reply keeps you on the card; only next/later/approve/deny move it. */
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
    setDecided((d) => [...d, { item: current, action, via, stamp: stampOf(current) }]);
    setQueue((q) => q.slice(1));
    setDraft("");
    setImages([]);
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
  // Sending a reply keeps the card: you may want to watch the answer arrive. Moving on is yours (→ / ←).
  const sendReply = () => {
    const text = draft.trim();
    if (!current || (!text && !images.length)) return;
    const item = current;
    if (item.pendingQuestion && item.pendingQuestion.questions.length === 1 && text && !images.length) {
      onAnswer(item, item.pendingQuestion.requestId, { [item.pendingQuestion.questions[0].question]: text }); // a typed reply is the answer
      setDraft("");
      setImages([]);
      return;
    }
    onReply(item, text, images);
    setReplies((n) => n + 1);
    setDraft("");
    setImages([]);
    setFlash("sent");
    setTimeout(() => setFlash(null), 900);
  };

  return { draft, setDraft, images, setImages, flash, replies, dir, advance, undo, approve, sendReply };
}
