import { useState, type Dispatch, type SetStateAction } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import type { ImageAttachment } from "../../../core/attention/content.ts";
import { popHead, stampOf, type Decision } from "../../../core/attention/queue.ts";
import { parseSlash, type SlashCommand } from "../../../core/attention/commands.ts";

/**
 * What a card can do, and the small state those actions leave behind: the reply draft and its images,
 * the 900ms flash on the badge ("approved", "denied"), the count of replies this pass, and which way the
 * last move went so the next card enters from that side. The queue and the decisions are the deck's
 * (useDeckQueue); this hook only writes to them. Every move pops the head and re-orders the rest by
 * score at that moment (popHead), the way a scheduler picks its next process when one leaves the CPU.
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
  commands = [],
  onCommand,
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
  /** Slash commands the reply box knows; a typed one runs for the card's conversation instead of being sent. */
  commands?: SlashCommand[];
  onCommand?: (item: AttentionItem, id: string, args: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [flash, setFlash] = useState<string | null>(null);
  /** Replies and answers sent this pass. Each hands the conversation to the agent: the card leaves the queue and comes back with the answer. */
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
    setQueue((q) => popHead(q));
    setDraft("");
    setImages([]);
  };
  /**
   * The conversation is the agent's now (a reply or an answer went out): its card leaves the ready queue
   * the way a process leaves for I/O, without a decision — when the turn finishes it is actionable again
   * and the merge puts it back by score, warm and yours, right behind whatever you are reading. Sending
   * already marks the conversation seen.
   */
  const leave = () => {
    setReplies((n) => n + 1);
    setDir("next");
    setQueue((q) => popHead(q));
    setDraft("");
    setImages([]);
  };
  /** Answer the card's pending question (the structured form); the card leaves with the answer. */
  const answer = (answers: Record<string, string | string[]>) => {
    if (!current?.pendingQuestion) return;
    onAnswer(current, current.pendingQuestion.requestId, answers);
    leave();
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
  // Sending a reply hands the card over: it leaves, and the answer brings it back to the front of what is left.
  const sendReply = () => {
    const text = draft.trim();
    if (!current || (!text && !images.length)) return;
    const item = current;
    // "/reload", "/compact all": a command the box knows runs as one (with images attached it is a message).
    const cmd = !images.length ? parseSlash(text) : null;
    if (cmd && onCommand && commands.some((c) => c.id === cmd.id)) {
      onCommand(item, cmd.id, cmd.args);
      setDraft("");
      setImages([]);
      return;
    }
    if (item.pendingQuestion && item.pendingQuestion.questions.length === 1 && text && !images.length) {
      onAnswer(item, item.pendingQuestion.requestId, { [item.pendingQuestion.questions[0].question]: text }); // a typed reply is the answer
      leave();
      return;
    }
    onReply(item, text, images);
    leave();
  };

  return { draft, setDraft, images, setImages, flash, replies, dir, advance, undo, approve, answer, sendReply };
}
