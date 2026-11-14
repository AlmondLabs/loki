import { useEffect, useEffectEvent, type RefObject } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import type { Decision } from "../../../core/attention/queue.ts";
import { registerActions } from "../shell/keymap";

/**
 * Whether O opens the card's chat, leaving the deck. An email or Slack thread (plan 067) is no chat until it is
 * handed off, so on its card O does nothing and the deck stays up.
 */
export const opensChat = (item: AttentionItem | undefined): item is AttentionItem => !!item && !item.outside;

/**
 * The deck's keys: its actions by keymap id, on the selected card. The handlers always reach the latest closures; the
 * actions register again when the selected card, the decisions or typing change, so the deck's registration stays the
 * newest one. Esc is not the deck's: it never leaves Flow, the same in every place (plan 2026-11-14-1330, KTD14).
 */
export function useDeckKeys({
  typing,
  current,
  decided,
  replyRef,
  read,
  later,
  archive,
  label,
  approve,
  undo,
  replySender = () => {},
  forward = () => {},
  onOpenDesk,
  onClose,
}: {
  typing: boolean;
  /** The selected card, undefined while there is none to act on (answered elsewhere, R11). */
  current: AttentionItem | undefined;
  decided: Decision[];
  replyRef: RefObject<HTMLTextAreaElement | null>;
  read: () => void;
  later: () => void;
  archive: () => void;
  label: () => void;
  approve: (behavior: "allow" | "deny" | "always") => void;
  undo: () => void;
  /** ⇧R on a mail card: reply to the sender alone (plan 076). */
  replySender?: () => void;
  /** F on a mail card: forward it (plan 076). */
  forward?: () => void;
  onOpenDesk: (agentId: string, conversationId: string) => void;
  /** O opened the card's chat: Flow is left for it. */
  onClose: () => void;
}) {
  const mailKey = useEffectEvent((mode: "reply" | "forward") => (mode === "reply" ? replySender() : forward()));
  // The deck's actions, by keymap id (the shell's key handler and the menu dispatch to them). The keymap
  // decides which keys reach here while the reply box has focus: ⌘] ⌘[ ⌘E ⌘↵ ⌘⇧D ⌘O do, plain letters do not.
  const act = useEffectEvent((action: "read" | "later" | "archive" | "label" | "approve" | "deny" | "reply" | "open" | "undo") => {
    switch (action) {
      case "read":
        return read();
      case "later":
        return later();
      case "archive":
        return archive();
      case "label":
        return label();
      case "approve":
      case "deny":
        if (current?.pendingApproval) approve(action === "approve" ? "allow" : "deny");
        return;
      case "reply":
        return replyRef.current?.focus();
      case "open":
        if (!opensChat(current)) return;
        onOpenDesk(current.agent_id, current.id);
        onClose();
        return;
      case "undo":
        return undo();
    }
  });
  useEffect(() => {
    return registerActions({
      "inbox.next": () => act("read"),
      "inbox.later": () => act("later"),
      "inbox.archive": () => act("archive"),
      "inbox.label": () => act("label"),
      "inbox.approve": () => act("approve"),
      "inbox.deny": () => act("deny"),
      "inbox.reply": () => act("reply"),
      "inbox.open": () => act("open"),
      "inbox.undo": () => act("undo"),
      "inbox.reply_sender": () => mailKey("reply"),
      "inbox.forward": () => mailKey("forward"),
    });
  }, [typing, current, decided]);
}
