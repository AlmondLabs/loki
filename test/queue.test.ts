import { describe, expect, test } from "bun:test";
import type { AttentionItem } from "../core/attention/model.ts";
import { mergeQueue, popHead, stampOf } from "../core/attention/queue.ts";
import { scored } from "../core/attention/priority.ts";
import { attentionItem } from "./fixtures/attention.ts";

const item = attentionItem;

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
    // items arrive stamped, as buildItems hands them over
    const stamp = (i: AttentionItem) => scored([i], now)[0];
    const head = stamp(item("head", { lastMessageAt: "2026-09-16T06:00:00Z" }));
    const old = stamp(item("old", { lastMessageAt: "2026-09-16T07:00:00Z" }));
    const report = stamp(item("report", { lastMessageAt: "2026-09-16T09:59:00Z", lastAsk: "schedule" }));
    const warm = stamp(item("warm", { lastMessageAt: "2026-09-16T09:58:00Z", lastAsk: "person" }));
    const q = mergeQueue([head, old], [head, old, report, warm], []);
    expect(q.map((i) => i.id)).toEqual(["head", "warm", "report", "old"]);
    // the head stays even when something blocked arrives; the blocked card is next
    const blocked = stamp(item("blocked", { status: "approval", pendingApproval: { requestId: "p", toolName: "Bash", input: {}, at: "2026-09-16T09:59:30Z" }, lastMessageAt: "2026-09-16T09:59:30Z" }));
    expect(mergeQueue(q, [head, old, report, warm, blocked], []).map((i) => i.id)).toEqual(["head", "blocked", "warm", "report", "old"]);
  });

  test("popHead drops the head and orders the rest by their stamped score", () => {
    const head = item("head", { score: 3 });
    const low = item("low", { score: -1 });
    const high = item("high", { score: 9 });
    // the tail was ordered earlier with low ahead; the stamps say high leads
    expect(popHead([head, low, high]).map((i) => i.id)).toEqual(["high", "low"]);
    expect(popHead([head])).toEqual([]);
  });

  test("returns the same array when nothing changed", () => {
    const a = item("a");
    const q = [a];
    expect(mergeQueue(q, [a], [])).toBe(q);
  });
});
