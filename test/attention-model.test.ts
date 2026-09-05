import { describe, expect, test } from "bun:test";
import { applyEvent, buildItems, digest, emptyLive, keyOf, toConversations, type ConversationInfo } from "../app/src/attention/model";
import { toTranscript } from "../shared/harness.ts";

const msg = (message_type: string, extra: Record<string, unknown>) => ({ message_type, date: "2026-09-05T08:00:00Z", ...extra });

describe("attention model (browser)", () => {
  test("toConversations drops archived and stale, titles main chats by agent name", () => {
    const now = new Date("2026-09-05T10:00:00Z").getTime();
    const convs = toConversations(
      [
        { id: "c1", agent_id: "a1", summary: "Sleep", last_message_at: "2026-09-05T08:00:00Z", archived: false },
        { id: "default", agent_id: "a1", summary: null, last_message_at: "2026-09-05T09:00:00Z", archived: false },
        { id: "c-old", agent_id: "a1", summary: "Old", last_message_at: "2026-08-01T00:00:00Z", archived: false },
        { id: "c-arch", agent_id: "a1", summary: "Arch", last_message_at: "2026-09-05T09:30:00Z", archived: true },
      ],
      new Map([["a1", "ira"]]),
      7,
      now,
    );
    expect(convs.map((c) => `${c.id}:${c.title}`)).toEqual(["default:ira · main chat", "c1:Sleep"]);
    expect(convs.every((c) => c.agentName === "ira")).toBe(true);
  });

  test("digest reads the last human/assistant roles; harness-injected user text does not count as the user speaking", () => {
    const d = digest([
      msg("user_message", { content: "go" }),
      msg("assistant_message", { content: [{ type: "text", text: "Which one?" }] }),
      msg("user_message", { content: "<task-notification><task-id>t</task-id></task-notification>" }),
    ]);
    expect(d).toEqual({ lastRole: "assistant", lastAssistantText: "Which one?" });
  });

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
