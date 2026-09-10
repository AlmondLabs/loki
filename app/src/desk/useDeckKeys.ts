import { useEffect, type RefObject } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import type { Decision } from "../../../core/attention/queue.ts";
import { registerActions } from "../shell/keymap";

/**
 * The deck's keys: its actions by keymap id, and Esc with the reply box idle. Re-registers whenever
 * the closures it hands out would go stale (the current card, the decisions, the draft, typing).
 */
export function useDeckKeys({
  typing,
  current,
  decided,
  draft,
  replyRef,
  advance,
  approve,
  undo,
  onOpenDesk,
  onClose,
  setShowSnoozed,
}: {
  typing: boolean;
  current: AttentionItem | undefined;
  decided: Decision[];
  draft: string;
  replyRef: RefObject<HTMLTextAreaElement | null>;
  advance: (action: "seen" | "unread") => void;
  approve: (behavior: "allow" | "deny") => void;
  undo: () => void;
  onOpenDesk: (agentId: string, conversationId: string) => void;
  onClose: () => void;
  setShowSnoozed: (update: (v: boolean) => boolean) => void;
}) {
  // The deck's actions, by keymap id (the shell's key handler and the menu dispatch to them). The keymap
  // decides which keys reach here while the reply box has focus: ⌘] ⌘[ ⌘↵ ⌘⌫ ⌘O ⌘S do, plain letters do not.
  useEffect(() => {
    return registerActions({
      "inbox.next": () => advance("seen"),
      "inbox.later": () => advance("unread"),
      "inbox.approve": () => {
        if (current?.pendingApproval) approve("allow");
      },
      "inbox.deny": () => {
        if (current?.pendingApproval) approve("deny");
      },
      "inbox.reply": () => replyRef.current?.focus(),
      "inbox.open": () => {
        if (!current) return;
        onOpenDesk(current.agentId, current.id);
        onClose();
      },
      "inbox.undo": () => undo(),
      "inbox.snoozed": () => setShowSnoozed((v) => !v),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typing, current, decided, draft]);
  // Esc with the box idle closes the deck (the box handles its own Esc: keep a draft, or close when empty).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A layer over the inbox (the desks tree, a dialog) owns Esc while it is up: it closes, the inbox stays.
      if (e.key === "Escape" && !typing && !document.querySelector('[role="dialog"]')) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typing]);
}
