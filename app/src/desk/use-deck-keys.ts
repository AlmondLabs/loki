import { useEffect, useEffectEvent, type RefObject } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import type { Decision } from "../../../core/attention/queue.ts";
import { registerActions } from "../shell/keymap";

export const opensChat = (item: AttentionItem | undefined): item is AttentionItem => !!item && !item.outside;

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
  current: AttentionItem | undefined;
  decided: Decision[];
  replyRef: RefObject<HTMLTextAreaElement | null>;
  read: () => void;
  later: () => void;
  archive: () => void;
  label: () => void;
  approve: (behavior: "allow" | "deny" | "always") => void;
  undo: () => void;
  replySender?: () => void;
  forward?: () => void;
  onOpenDesk: (agentId: string, conversationId: string) => void;
  onClose: () => void;
}) {
  const mailKey = useEffectEvent((mode: "reply" | "forward") => (mode === "reply" ? replySender() : forward()));
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
