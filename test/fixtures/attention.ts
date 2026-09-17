import type { AttentionItem } from "../../core/attention/model.ts";

/** One inbox item with every field filled in; tests override what they care about. Unscored until a test stamps it. */
export const attentionItem = (id: string, over: Partial<AttentionItem> = {}): AttentionItem => ({
  id,
  agentId: "a1",
  agentName: "ira",
  title: id,
  lastMessageAt: "2026-09-05T10:00:00Z",
  archived: false,
  status: "done",
  lastAssistantText: "x",
  lastRole: "assistant",
  pendingApproval: null,
  pendingQuestion: null,
  turns: 0,
  error: null,
  seenAt: null,
  unread: true,
  lastAsk: null,
  score: 0,
  reason: "report",
  runtime: { agent_id: "a1", conversation_id: id },
  ...over,
});
