import { describe, expect, test } from "bun:test";
import { applyEvent, buildItems, cancelQueued, chatStatusOf, emptyLive, keyOf, takeQueued, type ConversationInfo } from "../core/attention/model.ts";
import { toTranscript } from "../core/harness.ts";

const msg = (message_type: string, extra: Record<string, unknown>) => ({ message_type, date: "2026-09-05T08:00:00Z", ...extra });

describe("attention model (browser)", () => {
  test("buildItems classifies approval / question / done / running / idle and sorts", () => {
    const convs: ConversationInfo[] = [
      { id: "done", agentId: "a", agentName: "ira", title: "Done", lastMessageAt: "2026-09-05T08:00:00Z", archived: false },
      { id: "q", agentId: "a", agentName: "ira", title: "Q", lastMessageAt: "2026-09-05T07:00:00Z", archived: false },
      { id: "appr", agentId: "a", agentName: "ira", title: "Appr", lastMessageAt: "2026-09-05T06:00:00Z", archived: false },
      { id: "seen", agentId: "a", agentName: "ira", title: "Seen", lastMessageAt: "2026-09-05T05:00:00Z", archived: false },
      { id: "run", agentId: "a", agentName: "ira", title: "Run", lastMessageAt: "2026-09-05T04:00:00Z", archived: false },
    ];
    const digests = new Map([
      [keyOf("a", "done"), { lastRole: "assistant" as const, lastAssistantText: "Finished." }],
      [keyOf("a", "q"), { lastRole: "assistant" as const, lastAssistantText: "Should I proceed?" }],
      [keyOf("a", "appr"), { lastRole: "assistant" as const, lastAssistantText: "Running it." }],
      [keyOf("a", "seen"), { lastRole: "assistant" as const, lastAssistantText: "Old news." }],
      [keyOf("a", "run"), { lastRole: "user" as const, lastAssistantText: null }],
    ]);
    const live = new Map();
    const appr = emptyLive();
    applyEvent(appr, { type: "control_request", request_id: "perm-1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" } }, agent_id: "a", conversation_id: "appr" });
    live.set(keyOf("a", "appr"), appr);
    const run = emptyLive();
    applyEvent(run, { type: "update_loop_status", runtime: { agent_id: "a", conversation_id: "run" }, loop_status: { status: "PROCESSING_API_RESPONSE" } });
    live.set(keyOf("a", "run"), run);
    const items = buildItems(convs, digests, live, { [keyOf("a", "seen")]: "2026-09-05T09:00:00Z" });
    expect(items.map((i) => `${i.id}:${i.status}`)).toEqual(["appr:approval", "q:question", "done:done", "run:running", "seen:idle"]);
    expect(items[0].pendingApproval).toMatchObject({ requestId: "perm-1", toolName: "Bash" });
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

  test("toTranscript maps protocol messages to a readable thread", () => {
    const t = toTranscript([
      msg("user_message", { content: "<system-reminder>x</system-reminder>go" }),
      msg("reasoning_message", { reasoning: "hmm" }),
      msg("tool_call_message", { tool_call: { name: "Bash" } }),
      msg("tool_return_message", { tool_return: "ok" }),
      msg("user_message", { content: "<task-notification><task-id>b1</task-id><status>completed</status><summary>ran</summary><result>a &gt; b</result></task-notification>" }),
      msg("assistant_message", { content: "Done." }),
    ]);
    expect(t.map((m) => `${m.role}:${m.text}`)).toEqual(["user:go", "tool:Bash", "event:background task b1 completed", "assistant:Done."]);
    expect(t[2]).toMatchObject({ summary: "ran", detail: "a > b" });
  });
});

describe("live transcript tail", () => {
  test("user, tool and assistant rows fold in order; own sends are not echoed twice; streaming settles", () => {
    const l = emptyLive();
    l.tail.push({ role: "user", text: "hello" });
    l.ownSends.push("hello");
    applyEvent(l, { type: "stream_delta", runtime: { agent_id: "a", conversation_id: "c" }, delta: { message_type: "user_message", content: "hello" } });
    expect(l.tail).toEqual([{ role: "user", text: "hello" }]); // echo recognised
    applyEvent(l, { type: "update_loop_status", runtime: { agent_id: "a", conversation_id: "c" }, loop_status: { status: "PROCESSING_API_RESPONSE" } });
    expect(chatStatusOf(l)).toBe("thinking");
    applyEvent(l, { type: "stream_delta", runtime: { agent_id: "a", conversation_id: "c" }, delta: { message_type: "assistant_message", content: "Let me " } });
    expect(chatStatusOf(l)).toBe("streaming");
    applyEvent(l, { type: "stream_delta", runtime: { agent_id: "a", conversation_id: "c" }, delta: { message_type: "tool_call_message", tool_call: { name: "Bash", tool_call_id: "t1" } } });
    applyEvent(l, { type: "stream_delta", runtime: { agent_id: "a", conversation_id: "c" }, delta: { message_type: "tool_call_message", tool_call: { name: "Bash", tool_call_id: "t1" } } }); // same call, more deltas
    expect(l.tail).toEqual([{ role: "user", text: "hello" }, { role: "assistant", text: "Let me" }, { role: "tool", text: "Bash" }]);
    applyEvent(l, { type: "stream_delta", runtime: { agent_id: "a", conversation_id: "c" }, delta: { message_type: "assistant_message", content: "done." } });
    applyEvent(l, { type: "update_loop_status", runtime: { agent_id: "a", conversation_id: "c" }, loop_status: { status: "WAITING_ON_INPUT" } });
    expect(l.tail.at(-1)).toEqual({ role: "assistant", text: "done." });
    expect(chatStatusOf(l)).toBe("idle");
    // a message typed elsewhere (Desktop) shows up as a user row
    applyEvent(l, { type: "stream_delta", runtime: { agent_id: "a", conversation_id: "c" }, delta: { message_type: "user_message", content: "from desktop" } });
    expect(l.tail.at(-1)).toEqual({ role: "user", text: "from desktop" });
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
    expect(l.tail.at(-1)).toEqual({ role: "assistant", text: "here is the answer" });
    applyEvent(l, { type: "turn_finished", runtime: rt }); // arrives late, with nothing left to settle
    expect(l.lastAssistantText).toBe("here is the answer");
    expect(l.tail.length).toBe(1);
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
    l.tail.push({ role: "user", text: "first", queued: true }, { role: "user", text: "second", queued: true });
    expect(takeQueued(l)).toBeNull();
    applyEvent(l, { type: "update_loop_status", runtime: rt, loop_status: { status: "WAITING_ON_INPUT" } });
    expect(takeQueued(l)).toEqual({ text: "first", images: [] });
    expect(l.tail.map((r) => [r.text, r.queued === true])).toEqual([["first", false], ["second", true]]);
    expect(l.queued.map((q) => q.text)).toEqual(["second"]);
    expect(takeQueued(l)).toEqual({ text: "second", images: [] }); // the caller marks inTurn again before the next; here the turn is over
    expect(takeQueued(l)).toBeNull();
  });
  test("cancel drops the message and its row; an unknown text changes nothing", () => {
    const l = emptyLive();
    l.inTurn = true;
    l.queued.push({ text: "oops", images: [] });
    l.tail.push({ role: "user", text: "kept" }, { role: "user", text: "oops", queued: true });
    expect(cancelQueued(l, "nope")).toBe(false);
    expect(cancelQueued(l, "oops")).toBe(true);
    expect(l.queued).toEqual([]);
    expect(l.tail.map((r) => r.text)).toEqual(["kept"]);
  });
});

describe("one marker per tool call", () => {
  test("the approval_request_message for a call already announced does not add a second row", () => {
    const l = emptyLive();
    const rt = { agent_id: "a", conversation_id: "c" };
    applyEvent(l, { type: "stream_delta", runtime: rt, delta: { message_type: "tool_call_message", tool_call: { name: "AskUserQuestion", tool_call_id: "t1" } } });
    applyEvent(l, { type: "stream_delta", runtime: rt, delta: { message_type: "approval_request_message", tool_call: { name: "AskUserQuestion", tool_call_id: "approval-9" } } });
    applyEvent(l, { type: "stream_delta", runtime: rt, delta: { message_type: "approval_request_message", tool_call: { name: "AskUserQuestion" } } });
    expect(l.tail.filter((r) => r.role === "tool").length).toBe(1);
    // a genuinely new call of the same tool after some text is a new row
    applyEvent(l, { type: "stream_delta", runtime: rt, delta: { message_type: "assistant_message", content: "and again" } });
    applyEvent(l, { type: "stream_delta", runtime: rt, delta: { message_type: "tool_call_message", tool_call: { name: "AskUserQuestion", tool_call_id: "t2" } } });
    expect(l.tail.filter((r) => r.role === "tool").length).toBe(2);
  });
});

describe("harness machinery in a live user message", () => {
  test("the desk block and a loaded skill become event rows; the user's own words stay a user row", () => {
    const l = emptyLive();
    const rt = { agent_id: "a", conversation_id: "c" };
    applyEvent(l, { type: "stream_delta", runtime: rt, delta: { message_type: "user_message", content: 'build it\n\n<loki-desk desk="c">\n- moved "x" to (1, 2)\n</loki-desk>' } });
    expect(l.tail).toEqual([
      { role: "event", text: "desk activity", summary: "1 gesture on c", detail: 'moved "x" to (1, 2)' },
      { role: "user", text: "build it" },
    ]);
    // a message that is only machinery changes the tail but is not the user speaking
    const r = applyEvent(l, { type: "stream_delta", runtime: rt, delta: { message_type: "user_message", content: '<skill_content name="unslop">\n# Unslop\n</skill_content>' } });
    expect(r).toEqual({ changed: true, userSpoke: false });
    expect(l.tail[2]).toEqual({ role: "event", text: "skill loaded", summary: "unslop", detail: "# Unslop" });
  });
});
