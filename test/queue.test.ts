import { describe, expect, test } from "vitest";
import type { AttentionItem } from "../core/attention/model.ts";
import { leaveRow, mergeQueue, stampOf } from "../core/attention/queue.ts";
import { scored } from "../core/attention/priority.ts";
import { attentionItem } from "./fixtures/attention.ts";

const item = attentionItem;

describe("catch up queue merge", () => {
  test("new items join below the selected card by score; a chat whose agent is mid-turn drops out, a read one stays", () => {
    const a = item("a"),
      b = item("b"),
      c = item("c");
    const q = mergeQueue([a, b], [a, item("b", { status: "running" }), c], [], { selectedId: "a1/a" });
    expect(q.map((i) => i.id)).toEqual(["a", "c"]);
    // a chat you have read is still in the Inbox: it stays until it is archived
    expect(mergeQueue([a, b], [a, item("b", { status: "idle", unread: false })], [], { selectedId: "a1/a" }).map((i) => i.id)).toEqual(["a", "b"]);
  });

  test("the selected card stays even when it stops being in the Inbox, wherever it sits; the first row is not pinned (R11)", () => {
    const a = item("a"),
      b = item("b"),
      c = item("c");
    const q = mergeQueue([a, b, c], [item("a", { status: "running" }), item("b", { status: "running" }), c], [], { selectedId: "a1/b" });
    expect(q.map((i) => i.id)).toEqual(["b", "c"]);
  });

  test("rows never reorder within a visit: a row whose score rose stays where it is", () => {
    const a = item("a", { score: 5 }),
      b = item("b", { score: 1 }),
      c = item("c", { score: 3 });
    const q = [a, b, c];
    expect(mergeQueue(q, [a, item("b", { score: 1 }), item("c", { score: 9 })], [], { selectedId: "a1/a" })).toBe(q);
  });

  test("Covers AE1. an arrival that outscores everything lands directly under the selection, and the rows above it keep their places", () => {
    const a = item("a", { score: 5 }),
      b = item("b", { score: 3 }),
      c = item("c", { score: 1 }),
      d = item("d", { score: 50 });
    const q = mergeQueue([a, b, c], [a, b, c, d], [], { selectedId: "a1/b" });
    expect(q.map((i) => i.id)).toEqual(["a", "b", "d", "c"]);
    // one that scores below a row under the selection goes after it
    const e = item("e", { score: 2 });
    expect(mergeQueue(q, [a, b, c, d, e], [], { selectedId: "a1/b" }).map((i) => i.id)).toEqual(["a", "b", "d", "e", "c"]);
  });

  test("a row that leaves closes the gap; the rest keep their order", () => {
    const a = item("a", { score: 1 }),
      b = item("b", { score: 9 }),
      c = item("c", { score: 5 });
    expect(mergeQueue([a, b, c], [b, c], [], { selectedId: "a1/c" }).map((i) => i.id)).toEqual(["b", "c"]);
  });

  test("Covers AE2. once the selection leaves a row held only because it was selected, the row goes; an actionable one stays", () => {
    const a = item("a"),
      b = item("b", { status: "approval" }),
      c = item("c");
    const answered = [a, item("b", { status: "running" }), c];
    const held = mergeQueue([a, b, c], answered, [], { selectedId: "a1/b" });
    expect(held.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(leaveRow(held, "a1/b", answered).map((i) => i.id)).toEqual(["a", "c"]);
    expect(leaveRow([a, b, c], "a1/b", [a, b, c])).toEqual([a, b, c]);
  });

  test("a conversation decided this pass comes back only when it has moved on", () => {
    const a = item("a");
    const decided = [{ item: a, action: "seen" as const, stamp: stampOf(a) }];
    // same message, still unread (kept unread): not re-queued
    expect(mergeQueue([], [a], decided)).toEqual([]);
    // only the timestamp moved (turn boundary, list refresh, streaming): NOT re-queued
    const bumped = item("a", { last_message_at: "2026-09-05T10:05:00Z" });
    expect(mergeQueue([], [bumped], decided)).toEqual([]);
    // the agent said something new: re-queued
    const later = item("a", { last_message_at: "2026-09-05T10:05:00Z", lastAssistantText: "here is the answer" });
    expect(mergeQueue([], [later], decided).map((i) => i.id)).toEqual(["a"]);
    // a new approval on the same conversation: re-queued
    const approval = item("a", { status: "approval", pendingApproval: { requestId: "perm-1", toolName: "Bash", input: {}, at: "2026-09-05T10:06:00Z" } });
    expect(mergeQueue([], [approval], decided).map((i) => i.id)).toEqual(["a"]);
  });

  test("what arrives is placed by score, not appended: a card from the chat in focus goes right under the selection, a quiet one to the back", () => {
    const now = new Date("2026-09-16T10:00:00Z").getTime();
    // items arrive stamped, as buildItems hands them over; "focused" is the chat you have been working in
    const stamp = (i: AttentionItem) => scored([i], now, { "a1/focused": 0.5 })[0];
    const head = stamp(item("head", { last_message_at: "2026-09-16T06:00:00Z" }));
    const old = stamp(item("old", { last_message_at: "2026-09-16T07:00:00Z" }));
    const quiet = stamp(item("quiet", { last_message_at: "2026-09-16T09:59:00Z" }));
    const focused = stamp(item("focused", { last_message_at: "2026-09-16T09:58:00Z" }));
    const q = mergeQueue([head, old], [head, old, quiet, focused], [], { selectedId: "a1/head" });
    expect(q.map((i) => i.id)).toEqual(["head", "focused", "quiet", "old"]);
    // the selection stays even when something blocked arrives; the blocked card is next
    const blocked = stamp(
      item("blocked", {
        status: "approval",
        pendingApproval: { requestId: "p", toolName: "Bash", input: {}, at: "2026-09-16T09:59:30Z" },
        last_message_at: "2026-09-16T09:59:30Z",
      }),
    );
    expect(mergeQueue(q, [head, old, quiet, focused, blocked], [], { selectedId: "a1/head" }).map((i) => i.id)).toEqual([
      "head",
      "blocked",
      "focused",
      "quiet",
      "old",
    ]);
  });

  test("returns the same array when nothing changed", () => {
    const a = item("a");
    const q = [a];
    expect(mergeQueue(q, [a], [])).toBe(q);
  });
});

describe("an outside card in a visit (plan 067)", () => {
  const facts = (message: string, text: string) => ({
    account_id: "slack:T01:U02",
    provider: "slack" as const,
    account_label: "Acme",
    thread_id: "D1",
    generation: 1,
    owner_agent_id: "agent-work",
    owner_name: "Work",
    sender: "Grace",
    sender_address: null,
    subject: "lunch?",
    lines: [text],
    newest_message_id: message,
    newest_at: "2026-11-04T09:00:00Z",
    handoff_conversation_id: null,
    disconnected: null,
    unread_out_there: true,
  });
  const card = (message: string, text = "lunch?") =>
    item("D1#1", { kind: "outside", agent_id: "account:slack:T01:U02", lastAssistantText: text, outside: facts(message, text) });

  test("moved past, it comes back only with a newer message, not when its text reads differently", () => {
    const decided = [{ item: card("m1"), action: "seen" as const, stamp: stampOf(card("m1")) }];
    expect(mergeQueue([], [card("m1", "lunch? (edited)")], decided)).toEqual([]);
    expect(mergeQueue([], [card("m2")], decided).map((i) => i.id)).toEqual(["D1#1"]);
  });
});
