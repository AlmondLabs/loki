import { describe, expect, test } from "bun:test";
import type { AttentionItem } from "../app/src/attention/model";
import { mergeQueue, stampOf } from "../app/src/attention/queue";

const item = (id: string, over: Partial<AttentionItem> = {}): AttentionItem => ({
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
  runtime: { agent_id: "a1", conversation_id: id },
  ...over,
});

describe("catch up queue merge", () => {
  test("new items join at the end; the current card never moves; resolved items drop out", () => {
    const a = item("a"), b = item("b"), c = item("c");
    const q = mergeQueue([a, b], [a, item("b", { status: "idle", unread: false }), c], []);
    expect(q.map((i) => i.id)).toEqual(["a", "c"]);
    // current card stays even if it stopped being actionable
    expect(mergeQueue([a], [item("a", { status: "idle" })], []).map((i) => i.id)).toEqual(["a"]);
  });

  test("a conversation decided this pass comes back only when it has moved on", () => {
    const a = item("a");
    const decided = [{ item: a, action: "seen" as const, stamp: stampOf(a) }];
    // same message, still unread (kept unread): not re-queued
    expect(mergeQueue([], [a], decided)).toEqual([]);
    // only the timestamp moved (turn boundary, list refresh, streaming): NOT re-queued
    const bumped = item("a", { lastMessageAt: "2026-09-05T10:05:00Z" });
    expect(mergeQueue([], [bumped], decided)).toEqual([]);
    // the agent said something new: re-queued
    const later = item("a", { lastMessageAt: "2026-09-05T10:05:00Z", lastAssistantText: "here is the answer" });
    expect(mergeQueue([], [later], decided).map((i) => i.id)).toEqual(["a"]);
    // a completed turn with no new text (e.g. it only wrote a file): re-queued
    expect(mergeQueue([], [item("a", { turns: 1 })], decided).map((i) => i.id)).toEqual(["a"]);
    // a new approval on the same conversation: re-queued
    const approval = item("a", { status: "approval", pendingApproval: { requestId: "perm-1", toolName: "Bash", input: {}, at: "2026-09-05T10:06:00Z" } });
    expect(mergeQueue([], [approval], decided).map((i) => i.id)).toEqual(["a"]);
  });

  test("returns the same array when nothing changed", () => {
    const a = item("a");
    const q = [a];
    expect(mergeQueue(q, [a], [])).toBe(q);
  });
});
