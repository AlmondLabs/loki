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
  onOpenChat,
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
  onOpenChat: (agentId: string, conversationId: string) => void;
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
        onOpenChat(current.agent_id, current.id);
        onClose();
        return;
      case "undo":
        return undo();
    }
  });
  useEffect(() => {
    return registerActions({
      "flow.next": () => act("read"),
      "flow.later": () => act("later"),
      "flow.archive": () => act("archive"),
      "flow.label": () => act("label"),
      "flow.approve": () => act("approve"),
      "flow.deny": () => act("deny"),
      "flow.reply": () => act("reply"),
      "flow.open": () => act("open"),
      "flow.undo": () => act("undo"),
      "flow.reply_sender": () => mailKey("reply"),
      "flow.forward": () => mailKey("forward"),
    });
  }, [typing, current, decided]);
}
