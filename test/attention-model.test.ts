import { describe, expect, test } from "bun:test";
import { applyEvent, buildItems, cancelQueued, emptyLive, keyOf, takeQueued, unviewed, viewStamp, type ConversationInfo } from "../core/attention/model.ts";

describe("attention model (browser)", () => {
  test("buildItems classifies approval / question / done / running / idle and orders by score", () => {
    const convs: ConversationInfo[] = [
      { id: "done", agentId: "a", agentName: "ira", title: "Done", lastMessageAt: "2026-09-05T08:00:00Z", archived: false },
      { id: "q", agentId: "a", agentName: "ira", title: "Q", lastMessageAt: "2026-09-05T07:00:00Z", archived: false },
      { id: "appr", agentId: "a", agentName: "ira", title: "Appr", lastMessageAt: "2026-09-05T06:00:00Z", archived: false },
      { id: "seen", agentId: "a", agentName: "ira", title: "Seen", lastMessageAt: "2026-09-05T05:00:00Z", archived: false },
      { id: "run", agentId: "a", agentName: "ira", title: "Run", lastMessageAt: "2026-09-05T04:00:00Z", archived: false },
    ];
    const digests = new Map([
      [keyOf("a", "done"), { lastRole: "assistant" as const, lastAssistantText: "Finished.", lastAsk: null }],
      [keyOf("a", "q"), { lastRole: "assistant" as const, lastAssistantText: "Should I proceed?", lastAsk: null }],
      [keyOf("a", "appr"), { lastRole: "assistant" as const, lastAssistantText: "Running it.", lastAsk: null }],
      [keyOf("a", "seen"), { lastRole: "assistant" as const, lastAssistantText: "Old news.", lastAsk: null }],
      [keyOf("a", "run"), { lastRole: "user" as const, lastAssistantText: null, lastAsk: null }],
    ]);
    const live = new Map();
    const appr = emptyLive();
    applyEvent(appr, { type: "control_request", request_id: "perm-1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" } }, agent_id: "a", conversation_id: "appr" }, "2026-09-05T09:30:00Z");
    live.set(keyOf("a", "appr"), appr);
    const run = emptyLive();
    applyEvent(run, { type: "update_loop_status", runtime: { agent_id: "a", conversation_id: "run" }, loop_status: { status: "PROCESSING_API_RESPONSE" } });
    live.set(keyOf("a", "run"), run);
    const items = buildItems(convs, digests, live, { [keyOf("a", "seen")]: "2026-09-05T09:00:00Z" }, new Date("2026-09-05T10:00:00Z").getTime());
    // by score (priority.ts): the two blocked cards first, the one waiting longest (the question, from 07:00) ahead; then the finished one; the rest by age
    expect(items.map((i) => `${i.id}:${i.status}`)).toEqual(["q:question", "appr:approval", "done:done", "seen:idle", "run:running"]);
    expect(items.find((i) => i.id === "appr")!.pendingApproval).toMatchObject({ requestId: "perm-1", toolName: "Bash" });
  });

  test("applyEvent: streaming text lands on stop, user speaking resets and reports", () => {
    const l = emptyLive();
    applyEvent(l, { type: "stream_delta", runtime: { agent_id: "a", conversation_id: "c" }, delta: { message_type: "assistant_message", content: "Hel" } });
    applyEvent(l, { type: "stream_delta", runtime: { agent_id: "a", conversation_id: "c" }, delta: { message_type: "assistant_message", content: "lo." } });
    expect(l.lastAssistantText).toBeNull();
    applyEvent(l, { type: "stream_delta", runtime: { agent_id: "a", conversation_id: "c" }, delta: { message_type: "stop_reason", stop_reason: "end_turn" } });
    expect(l.lastAssistantText).toBe("Hello.");
    const r = applyEvent(l, { type: "stream_delta", runtime: { agent_id: "a", conversation_id: "c" }, delta: { message_type: "user_message", content: "thanks" } });
    expect(r.userSpoke).toBe(true);
    expect(l.lastRole).toBe("user");
  });

});

describe("AskUserQuestion as a pending question", () => {
  test("a can_use_tool for AskUserQuestion becomes a question, not an approval, and clears when the loop moves on", () => {
    const l = emptyLive();
    applyEvent(l, { type: "control_request", request_id: "perm-q1", runtime: { agent_id: "a", conversation_id: "c" }, request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [{ question: "Ship it?", options: [{ label: "yes" }, { label: "no" }] }] } } });
    expect(l.pending).toBeNull();
    expect(l.pendingAsk?.requestId).toBe("perm-q1");
    expect(l.pendingAsk?.questions[0].options.map((o) => o.label)).toEqual(["yes", "no"]);
    const items = buildItems([{ id: "c", agentId: "a", agentName: "ira", title: "t", lastMessageAt: "2026-09-06T00:00:00Z", archived: false }], new Map(), new Map([[keyOf("a", "c"), l]]), {});
    expect(items[0].status).toBe("question");
    expect(items[0].pendingQuestion?.requestId).toBe("perm-q1");
    applyEvent(l, { type: "update_loop_status", runtime: { agent_id: "a", conversation_id: "c" }, loop_status: { status: "PROCESSING_API_RESPONSE" } });
    expect(l.pendingAsk).toBeNull();
  });
});

describe("a finished reply re-queues a decided card", () => {
  test("lastAssistantText updates when the loop goes idle before stop_reason/turn_finished, so the stamp changes", () => {
    const l = emptyLive();
    l.lastAssistantText = "earlier";
    const rt = { agent_id: "a", conversation_id: "c" };
    applyEvent(l, { type: "update_loop_status", runtime: rt, loop_status: { status: "PROCESSING_API_RESPONSE" } });
    applyEvent(l, { type: "stream_delta", runtime: rt, delta: { message_type: "assistant_message", content: "here is the answer" } });
    applyEvent(l, { type: "update_loop_status", runtime: rt, loop_status: { status: "WAITING_ON_INPUT" } });
    expect(l.lastAssistantText).toBe("here is the answer");
    expect(l.thread.rows()!.at(-1)).toMatchObject({ role: "assistant", text: "here is the answer" });
    applyEvent(l, { type: "turn_finished", runtime: rt }); // arrives late, with nothing left to settle
    expect(l.lastAssistantText).toBe("here is the answer");
    expect(l.thread.rows()!.length).toBe(1);
  });
});

describe("a turn that ends in a tool call still counts as new", () => {
  test("turns increments once per completed turn, on idle or turn_finished, never on streaming alone", () => {
    const l = emptyLive();
    const rt = { agent_id: "a", conversation_id: "c" };
    applyEvent(l, { type: "update_loop_status", runtime: rt, loop_status: { status: "SENDING_API_REQUEST" } });
    applyEvent(l, { type: "stream_delta", runtime: rt, delta: { message_type: "tool_call_message", tool_call: { name: "Write", tool_call_id: "t1" } } });
    expect(l.turns).toBe(0);
    applyEvent(l, { type: "update_loop_status", runtime: rt, loop_status: { status: "WAITING_ON_INPUT" } });
    expect(l.turns).toBe(1);
    applyEvent(l, { type: "turn_finished", runtime: rt }); // same turn, reported again: no double count
    expect(l.turns).toBe(1);
    applyEvent(l, { type: "update_loop_status", runtime: rt, loop_status: { status: "PROCESSING_API_RESPONSE" } });
    applyEvent(l, { type: "turn_finished", runtime: rt });
    expect(l.turns).toBe(2);
    const items = buildItems([{ id: "c", agentId: "a", agentName: "ira", title: "t", lastMessageAt: "2026-09-06T00:00:00Z", archived: false }], new Map(), new Map([[keyOf("a", "c"), l]]), {});
    expect(items[0].turns).toBe(2);
  });
});

describe("messages typed mid-turn", () => {
  const rt = { agent_id: "a", conversation_id: "c" };
  test("nothing leaves while the turn runs; one goes at each turn end, and its row stops being queued", () => {
    const l = emptyLive();
    applyEvent(l, { type: "update_loop_status", runtime: rt, loop_status: { status: "SENDING_API_REQUEST" } });
    l.queued.push({ text: "first", images: [] }, { text: "second", images: [] });
    l.thread.queue({ role: "user", text: "first" });
    l.thread.queue({ role: "user", text: "second" });
    expect(takeQueued(l)).toBeNull();
    applyEvent(l, { type: "update_loop_status", runtime: rt, loop_status: { status: "WAITING_ON_INPUT" } });
    expect(takeQueued(l)).toEqual({ text: "first", images: [] });
    expect(l.thread.rows()!.map((r) => [r.text, r.queued === true])).toEqual([["first", false], ["second", true]]);
    expect(l.queued.map((q) => q.text)).toEqual(["second"]);
    expect(takeQueued(l)).toEqual({ text: "second", images: [] }); // the caller marks inTurn again before the next; here the turn is over
    expect(takeQueued(l)).toBeNull();
  });
  test("cancel drops the message and its row; an unknown text changes nothing", () => {
    const l = emptyLive();
    l.inTurn = true;
    l.queued.push({ text: "oops", images: [] });
    l.thread.own({ role: "user", text: "kept" });
    l.thread.queue({ role: "user", text: "oops" });
    expect(cancelQueued(l, "nope")).toBe(false);
    expect(cancelQueued(l, "oops")).toBe(true);
    expect(l.queued).toEqual([]);
    expect(l.thread.rows()!.map((r) => r.text)).toEqual(["kept"]);
  });
});

describe("viewed, apart from done", () => {
  const conv: ConversationInfo = { id: "c", agentId: "a", agentName: "ira", title: "C", lastMessageAt: "2026-09-05T08:00:00Z", archived: false };
  const digests = new Map([[keyOf("a", "c"), { lastRole: "assistant" as const, lastAssistantText: "Finished.", lastAsk: null }]]);
  const now = new Date("2026-09-05T10:00:00Z").getTime();

  test("buildItems carries the look; a look does not make the item read", () => {
    const [i] = buildItems([conv], digests, new Map(), {}, now, { [keyOf("a", "c")]: "2026-09-05T09:00:00Z" });
    expect(i.viewedAt).toBe("2026-09-05T09:00:00Z");
    expect(i.unread).toBe(true);
    expect(i.status).toBe("done");
    expect(buildItems([conv], digests, new Map(), {}, now)[0].viewedAt).toBeNull();
  });

  test("unviewed: unread with something newer than the last look", () => {
    const base = { unread: true, lastMessageAt: "2026-09-05T08:00:00Z", viewedAt: null as string | null };
    expect(unviewed(base)).toBe(true);
    expect(unviewed({ ...base, viewedAt: "2026-09-05T07:59:59Z" })).toBe(true);
    expect(unviewed({ ...base, viewedAt: "2026-09-05T08:00:00Z" })).toBe(false);
    expect(unviewed({ ...base, viewedAt: "2026-09-05T08:00:00.000+00:00" })).toBe(false); // times compared as instants
    expect(unviewed({ ...base, unread: false })).toBe(false);
    expect(unviewed({ ...base, lastMessageAt: null, viewedAt: "2026-09-05T08:00:00Z" })).toBe(true); // nothing to compare: still new
  });

  test("viewStamp: one look per new last message, only while it is unread and unviewed", () => {
    const base = { agentId: "a", id: "c", unread: true, lastMessageAt: "2026-09-05T08:00:00Z", viewedAt: null as string | null };
    expect(viewStamp(base)).toBe("a/c@2026-09-05T08:00:00Z");
    expect(viewStamp({ ...base, viewedAt: "2026-09-05T09:00:00Z" })).toBeNull();
    expect(viewStamp({ ...base, unread: false })).toBeNull();
    expect(viewStamp({ ...base, lastMessageAt: null })).toBeNull();
    expect(viewStamp(null)).toBeNull();
  });
});

describe("a loop status that repeats changes nothing", () => {
  const rt = { agent_id: "a", conversation_id: "c" };
  const loop = (status: string) => ({ type: "update_loop_status", runtime: rt, loop_status: { status } });

  test("WAITING_ON_INPUT again, while idle, reports no change (nothing re-renders on it)", () => {
    const l = emptyLive();
    applyEvent(l, loop("PROCESSING_API_RESPONSE"));
    applyEvent(l, { type: "stream_delta", runtime: rt, delta: { message_type: "assistant_message", content: "Done." } });
    expect(applyEvent(l, loop("WAITING_ON_INPUT")).changed).toBe(true); // the turn ends: the reply settles, the turn counts
    expect(l.turns).toBe(1);
    expect(applyEvent(l, loop("WAITING_ON_INPUT")).changed).toBe(false);
    expect(applyEvent(l, loop("WAITING_ON_INPUT")).changed).toBe(false);
    expect(l.turns).toBe(1);
  });

  test("the first status on a fresh conversation, a new status, and a repeat that still clears something all count", () => {
    const l = emptyLive();
    expect(applyEvent(l, loop("WAITING_ON_INPUT")).changed).toBe(true); // unknown → idle
    expect(applyEvent(l, loop("PROCESSING_API_RESPONSE")).changed).toBe(true);
    expect(applyEvent(l, loop("PROCESSING_API_RESPONSE")).changed).toBe(false);
    l.error = "the turn failed";
    expect(applyEvent(l, loop("PROCESSING_API_RESPONSE")).changed).toBe(true); // a running status clears the error
    expect(l.error).toBeNull();
  });
});
