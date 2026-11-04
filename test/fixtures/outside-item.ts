import type { AttentionItem } from "../../core/attention/model.ts";
import { attentionItem } from "./attention.ts";

/**
 * An outside Inbox card (plan 067, U3): one unread Gmail thread, keyed by its account and thread rather than by an
 * agent and a chat, so nothing should open it as a chat.
 */
export const outsideItem = (title: string, over: Partial<AttentionItem> = {}): AttentionItem =>
  attentionItem("t1#1", {
    kind: "outside",
    agent_id: "account:gmail:ada@acme.com",
    agent_name: "ada@acme.com",
    title,
    outside: {
      account_id: "gmail:ada@acme.com",
      provider: "gmail",
      account_label: "ada@acme.com",
      thread_id: "t1",
      generation: 1,
      owner_agent_id: "a1",
      owner_name: "ira",
      sender: "Grace",
      sender_address: "grace@acme.com",
      subject: title,
      lines: ["Can you look?"],
      newest_message_id: "m1",
      newest_at: "2026-09-05T10:00:00Z",
      handoff_conversation_id: null,
      disconnected: null,
    },
    ...over,
  });
