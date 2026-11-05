import { describe, expect, test } from "vitest";
import { createCardMoves, type CardMovesHost } from "../core/attention/use-attention.ts";
import { keyOf, type AttentionItem } from "../core/attention/model.ts";
import { stampOf } from "../core/attention/queue.ts";
import { RETURN_TIMES_DEFAULT, type Rest } from "../core/attention/rest.ts";
import type { OutsideChange, OutsideFacts, OutsideWrite } from "../core/frame-types.ts";
import type { OutsideWritten } from "../core/attention/chat-store.ts";
import { attentionItem } from "./fixtures/attention.ts";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const facts = (over: Partial<OutsideFacts> = {}): OutsideFacts => ({
  account_id: "gmail:ada@acme.com",
  provider: "gmail",
  account_label: "ada@acme.com",
  thread_id: "t1",
  generation: 1,
  owner_agent_id: "ada",
  owner_name: "Ada",
  sender: "Grace",
  sender_address: "grace@acme.com",
  subject: "hi",
  lines: ["hi"],
  newest_message_id: "m1",
  newest_at: "2026-11-05T09:00:00Z",
  handoff_conversation_id: null,
  disconnected: null,
  unread_out_there: true,
  ...over,
});

const email = (over: Partial<AttentionItem> = {}): AttentionItem =>
  attentionItem("t1#1", { agent_id: "account:gmail:ada@acme.com", kind: "outside", outside: facts(), ...over });

/** A fake host: the rests, seen marks, write-backs and reports a move makes, with the daemon's answers as set. */
function host() {
  const rests: Record<string, Rest> = {};
  const marks: string[] = [];
  const calls: unknown[][] = [];
  const reported: string[] = [];
  const refuse = { outside: null as string | null };
  const change = (move: OutsideWrite, ended = false): OutsideChange => ({
    move,
    messages: [{ message_id: "m1", labels_added: move === "unread" ? ["UNREAD"] : [], labels_removed: move === "read" ? ["UNREAD"] : [] }],
    ended,
    was_unread: true,
  });
  const write =
    (move: OutsideWrite, ended = false) =>
    (card: { id: string }, labels?: string[]): Promise<OutsideWritten> => {
      if (refuse.outside) return Promise.resolve({ change: null, error: refuse.outside });
      calls.push([move, card.id, ...(labels ? [labels] : [])]);
      return Promise.resolve({ change: change(move, ended), error: null });
    };
  const h: CardMovesHost = {
    store: {
      markReadOutside: write("read"),
      markUnreadOutside: write("unread"),
      archiveOutside: write("archive", true),
      labelOutside: (card, labels) => write("label")(card, labels),
      restoreOutside: (card, c) => {
        if (refuse.outside) return Promise.resolve(refuse.outside);
        calls.push(["restore", card.id, c.move]);
        return Promise.resolve(null);
      },
      archiveConversation: (id, archived) => (calls.push([archived ? "archive_chat" : "unarchive_chat", id]), Promise.resolve(null)),
    },
    rests: () => rests,
    rest: (agentId, conversationId, rest) => {
      rests[keyOf(agentId, conversationId)] = rest;
    },
    markSeen: (agentId, conversationId) => void marks.push(`seen ${keyOf(agentId, conversationId)}`),
    unmarkSeen: (agentId, conversationId) => void marks.push(`unseen ${keyOf(agentId, conversationId)}`),
    returnTimes: () => RETURN_TIMES_DEFAULT,
    now: () => NOW,
    report: (_item, action) => void reported.push(action),
    reportUndone: (_item, action) => void reported.push(`undone ${action}`),
  };
  return { h, moves: createCardMoves(h), rests, marks, calls, reported, refuse };
}

const restOf = (rests: Record<string, Rest>, item: AttentionItem) => rests[keyOf(item.agent_id, item.id)];
const restsFor = (rests: Record<string, Rest>, item: AttentionItem) => Date.parse(restOf(rests, item).until) - NOW;

describe("moves on a card and their undo (plan 070, U6)", () => {
  test("⌘] on an email card marks it read out there and rests it; undo marks it unread again and clears the rest", async () => {
    const t = host();
    const item = email();
    expect(await t.moves.read(item, "key")).toMatchObject({ error: null, ask: false, rest: { kind: "read" } });
    expect(t.calls).toEqual([["read", "t1#1"]]);
    expect(t.marks).toEqual(["seen account:gmail:ada@acme.com/t1#1"]);
    expect(restsFor(t.rests, item)).toBe(HOUR);
    expect(t.reported).toEqual(["next"]);

    expect(await t.moves.undo(item)).toBeNull();
    expect(t.calls).toEqual([
      ["read", "t1#1"],
      ["restore", "t1#1", "read"],
    ]);
    expect(t.marks.at(-1)).toBe("unseen account:gmail:ada@acme.com/t1#1");
    expect(restOf(t.rests, item).until).toBe(new Date(NOW).toISOString());
    expect(t.reported.at(-1)).toBe("undone next");
    // Taken back once, there is nothing left to take back.
    expect(await t.moves.undo(item)).toBeNull();
    expect(t.calls).toHaveLength(2);
  });

  test("⌘E on an email card archives it; undo restores the thread", async () => {
    const t = host();
    const item = email();
    expect(await t.moves.archive(item, "key")).toBeNull();
    expect(t.calls).toEqual([["archive", "t1#1"]]);
    expect(t.reported).toEqual(["archive"]);
    expect(await t.moves.undo(item)).toBeNull();
    expect(t.calls.at(-1)).toEqual(["restore", "t1#1", "archive"]);
  });

  test("⌘[ on a read chat marks it unseen and rests it a day; undo marks it seen again", async () => {
    const t = host();
    const chat = attentionItem("c1", { unread: false });
    expect(await t.moves.later(chat, "key")).toMatchObject({ error: null, ask: false, rest: { kind: "later", n: 1 } });
    expect(t.marks).toEqual(["unseen a1/c1"]);
    expect(restsFor(t.rests, chat)).toBe(DAY);
    expect(t.calls).toEqual([]);
    expect(await t.moves.undo(chat)).toBeNull();
    expect(t.marks).toEqual(["unseen a1/c1", "seen a1/c1"]);
    expect(Date.parse(restOf(t.rests, chat).until)).toBe(NOW);
  });

  test("⌘[ on an email card leaves it unread out there and clears loki's seen mark", async () => {
    const t = host();
    const item = email({ unread: false });
    await t.moves.later(item, "key");
    expect(t.calls).toEqual([["unread", "t1#1"]]);
    expect(t.marks).toEqual(["unseen account:gmail:ada@acme.com/t1#1"]);
    expect(await t.moves.undo(item)).toBeNull();
    expect(t.calls.at(-1)).toEqual(["restore", "t1#1", "unread"]);
    expect(t.marks.at(-1)).toBe("seen account:gmail:ada@acme.com/t1#1");
  });

  test("a failed mark-read says why and sets no rest, no mark and nothing to undo", async () => {
    const t = host();
    const item = email();
    t.refuse.outside = "Gmail is out of reach";
    expect(await t.moves.read(item, "key")).toEqual({ error: "Gmail is out of reach", ask: false, rest: null });
    expect(t.rests).toEqual({});
    expect(t.marks).toEqual([]);
    expect(t.reported).toEqual([]);
    t.refuse.outside = null;
    expect(await t.moves.undo(item)).toBeNull();
    expect(t.calls).toEqual([]);
  });

  test("undo after a reply with archive restores the thread and leaves the sent reply alone", async () => {
    const t = host();
    const item = email();
    const archived: OutsideChange = { move: "archive", messages: [], ended: true, was_unread: true };
    t.moves.replied(item, "archive", archived);
    expect(t.reported).toEqual(["reply"]);
    expect(await t.moves.undo(item)).toBeNull();
    expect(t.calls).toEqual([["restore", "t1#1", "archive"]]);
  });

  test("a reply with read rests the card on the first rung; with later, a day", () => {
    const t = host();
    const item = email();
    t.moves.replied(item, "read", { move: "read", messages: [], ended: false, was_unread: true });
    expect(restsFor(t.rests, item)).toBe(HOUR);
    t.moves.replied(item, "later", { move: "unread", messages: [], ended: false, was_unread: true });
    expect(restsFor(t.rests, item)).toBe(DAY);
  });

  test("⌘[ or ⌘] on a card waiting for approval moves past for the visit and sets no rest", async () => {
    const t = host();
    const blocked = attentionItem("c1", { status: "approval", pendingApproval: { requestId: "r1", toolName: "bash", input: {}, at: "2026-11-05T11:00:00Z" } });
    expect(await t.moves.later(blocked, "key")).toEqual({ error: null, ask: false, rest: null });
    expect(await t.moves.read(blocked, "key")).toEqual({ error: null, ask: false, rest: null });
    expect(t.rests).toEqual({});
    expect(t.calls).toEqual([]);
  });

  test("the second ⌘[ on an unchanged card asks, and does nothing until the pick comes", async () => {
    const t = host();
    const chat = attentionItem("c1", { unread: false });
    await t.moves.later(chat, "key");
    // The rest has ended and the card is back, unchanged.
    const back = { ...chat, unread: true };
    expect(t.moves.laterAsks(back)).toBe(true);
    const before = restOf(t.rests, chat);
    expect(await t.moves.later(back, "key")).toEqual({ error: null, ask: true, rest: null });
    expect(restOf(t.rests, chat)).toBe(before);
    const pick = new Date(NOW + 3 * DAY).toISOString();
    expect(await t.moves.later(back, "key", pick)).toMatchObject({ error: null, ask: false, rest: { n: 2, until: pick, kind: "later" } });
    // Something new starts the count over.
    expect(t.moves.laterAsks({ ...back, lastAssistantText: "something new" })).toBe(false);
    expect(stampOf(back)).toBe(restOf(t.rests, chat).stamp);
  });

  test("a label on an email card is written and stays for the next key; undo takes the label off", async () => {
    const t = host();
    const item = email();
    expect(await t.moves.label(item, ["L1"], "key")).toBeNull();
    expect(t.calls).toEqual([["label", "t1#1", ["L1"]]]);
    expect(t.rests).toEqual({});
    expect(await t.moves.undo(item)).toBeNull();
    expect(t.calls.at(-1)).toEqual(["restore", "t1#1", "label"]);
  });

  test("a hand-off is not taken back, and says so", async () => {
    const t = host();
    const item = email();
    t.moves.handedOff(item);
    expect(await t.moves.undo(item)).toBe("handed off");
    expect(t.calls).toEqual([]);
  });

  test("⌘] on a chat rests it on the ladder, and undo puts back the rung it had and its unread mark", async () => {
    const t = host();
    const chat = attentionItem("c1", { unread: true });
    await t.moves.read(chat, "key");
    expect(t.marks).toEqual(["seen a1/c1"]);
    expect(restOf(t.rests, chat)).toMatchObject({ kind: "read" });
    await t.moves.undo(chat);
    expect(t.marks).toEqual(["seen a1/c1", "unseen a1/c1"]);
    expect(restOf(t.rests, chat)).toEqual({ n: 0, until: new Date(NOW).toISOString(), stamp: "", at: new Date(NOW).toISOString() });
  });

  test("an archived chat comes back on undo", async () => {
    const t = host();
    const chat = attentionItem("c1");
    expect(await t.moves.archive(chat, "key")).toBeNull();
    expect(await t.moves.undo(chat)).toBeNull();
    expect(t.calls).toEqual([
      ["archive_chat", "c1"],
      ["unarchive_chat", "c1"],
    ]);
  });
});
