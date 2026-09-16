import { describe, expect, test } from "bun:test";
import type { AttentionItem } from "../core/attention/model.ts";
import { mergeQueue, popHead, stampOf } from "../core/attention/queue.ts";

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
  test("new items join behind the head by score; the current card never moves; resolved items drop out", () => {
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

  test("what arrives is placed by score, not appended: a warm reply to you goes right behind the head, a cold report to the back", () => {
    const now = new Date("2026-09-16T10:00:00Z").getTime();
    const head = item("head", { lastMessageAt: "2026-09-16T06:00:00Z" });
    const old = item("old", { lastMessageAt: "2026-09-16T07:00:00Z" });
    const warm = item("warm", { lastMessageAt: "2026-09-16T09:58:00Z", lastAsk: { at: "2026-09-16T09:57:00Z", scheduled: false } });
    const report = item("report", { lastMessageAt: "2026-09-16T09:59:00Z", lastAsk: { at: "2026-09-16T09:58:00Z", scheduled: true } });
    const q = mergeQueue([head, old], [head, old, report, warm], [], false, now);
    expect(q.map((i) => i.id)).toEqual(["head", "warm", "report", "old"]);
    // the head stays even when something blocked arrives; the blocked card is next
    const blocked = item("blocked", { status: "approval", pendingApproval: { requestId: "p", toolName: "Bash", input: {}, at: "2026-09-16T09:59:30Z" }, lastMessageAt: "2026-09-16T09:59:30Z" });
    expect(mergeQueue(q, [head, old, report, warm, blocked], [], false, now).map((i) => i.id)).toEqual(["head", "blocked", "warm", "report", "old"]);
  });

  test("popHead drops the head and orders the rest by score at that moment", () => {
    const now = new Date("2026-09-16T10:00:00Z").getTime();
    const head = item("head");
    const cold = item("cold", { lastMessageAt: "2026-09-16T08:00:00Z" });
    const warm = item("warm", { lastMessageAt: "2026-09-16T09:59:00Z" });
    // the tail was ordered earlier with cold ahead; by now warm has arrived and leads
    expect(popHead([head, cold, warm], now).map((i) => i.id)).toEqual(["warm", "cold"]);
    // ten minutes on, warm has cooled and the newer card still leads, by age alone
    expect(popHead([head, cold, warm], now + 10 * 60_000).map((i) => i.id)).toEqual(["warm", "cold"]);
    expect(popHead([head], now)).toEqual([]);
  });

  test("returns the same array when nothing changed", () => {
    const a = item("a");
    const q = [a];
    expect(mergeQueue(q, [a], [])).toBe(q);
  });
});
