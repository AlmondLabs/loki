import { useEffect, useEffectEvent, type RefObject } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import type { Decision } from "../../../core/attention/queue.ts";
import { registerActions } from "../shell/keymap";

/**
 * The deck's keys: its actions by keymap id, and Esc with the reply box idle. The handlers always reach
 * the latest closures; the actions register again when the current card, the decisions or typing change,
 * so the deck's registration stays the newest one.
 */
export function useDeckKeys({
  typing,
  current,
  decided,
  replyRef,
  next,
  archive,
  approve,
  undo,
  onOpenDesk,
  onClose,
}: {
  typing: boolean;
  current: AttentionItem | undefined;
  decided: Decision[];
  replyRef: RefObject<HTMLTextAreaElement | null>;
  next: () => void;
  archive: () => void;
  approve: (behavior: "allow" | "deny" | "always") => void;
  undo: () => void;
  onOpenDesk: (agentId: string, conversationId: string) => void;
  onClose: () => void;
}) {
  // The deck's actions, by keymap id (the shell's key handler and the menu dispatch to them). The keymap
  // decides which keys reach here while the reply box has focus: ⌘] ⌘E ⌘↵ ⌘⇧D ⌘O do, plain letters do not.
  const act = useEffectEvent((action: "next" | "archive" | "approve" | "deny" | "reply" | "open" | "undo") => {
    switch (action) {
      case "next":
        return next();
      case "archive":
        return archive();
      case "approve":
      case "deny":
        if (current?.pendingApproval) approve(action === "approve" ? "allow" : "deny");
        return;
      case "reply":
        return replyRef.current?.focus();
      case "open":
        if (!current) return;
        onOpenDesk(current.agent_id, current.id);
        onClose();
        return;
      case "undo":
        return undo();
    }
  });
  useEffect(() => {
    return registerActions({
      "inbox.next": () => act("next"),
      "inbox.archive": () => act("archive"),
      "inbox.approve": () => act("approve"),
      "inbox.deny": () => act("deny"),
      "inbox.reply": () => act("reply"),
      "inbox.open": () => act("open"),
      "inbox.undo": () => act("undo"),
    });
  }, [typing, current, decided]);
  // Esc with the box idle closes the deck (the box handles its own Esc: keep a draft, or close when empty).
  const close = useEffectEvent(() => onClose());
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A layer over the inbox (search, a dialog) owns Esc while it is up: it closes, the inbox stays.
      if (e.key === "Escape" && !typing && !document.querySelector('[role="dialog"]')) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [typing]);
}
