import { describe, expect, test } from "bun:test";
import { createAppServerChat } from "../mod/chat-appserver.ts";
import type { AppServerEvent, EventListener, Runtime } from "../mod/app-server.ts";

function fakeClient() {
  const listeners = new Set<EventListener>();
  const subscribed = new Set<string>();
  const sent: Array<{ rt: Runtime; text: string }> = [];
  return {
    on: (fn: EventListener) => (listeners.add(fn), () => listeners.delete(fn)),
    runtimeStart: async (rt: Runtime) => (subscribed.add(rt.conversation_id), { type: "runtime_start_response", success: true } as AppServerEvent),
    isSubscribed: (rt: Runtime) => subscribed.has(rt.conversation_id),
    sendUserMessage: async (rt: Runtime, text: string) => (sent.push({ rt, text }), { accepted: true, disposition: "queued" as string }),
    emit: (e: AppServerEvent) => listeners.forEach((fn) => fn(e)),
    sent,
    subscribed,
  };
}

const rt = { agent_id: "agent-1", conversation_id: "local-conv-abc" };
const scope = "local-conv-abc";

function harness() {
  const client = fakeClient();
  const frames: Array<[string, Record<string, unknown>]> = [];
  const chat = createAppServerChat({
    client,
    desks: { get: (s) => (s === scope ? rt : undefined) },
    broadcast: (f, s) => frames.push([s, f as Record<string, unknown>]),
    history: async () => [],
  });
  return { client, frames, chat, types: () => frames.map(([s, f]) => `${s}:${f.type}${f.state ? ":" + f.state : ""}`) };
}

describe("app-server chat mirror", () => {
  test("attach subscribes once; unbound desks are ignored", async () => {
    const { client, chat } = harness();
    await chat.attach(scope);
    await chat.attach(scope);
    await chat.attach("other");
    expect([...client.subscribed]).toEqual(["local-conv-abc"]);
  });

  test("assistant deltas stream, loop idle closes the bubble, tool calls show thinking", async () => {
    const { client, chat, frames, types } = harness();
    await chat.attach(scope);
    client.emit({ type: "update_loop_status", runtime: rt, loop_status: { status: "PROCESSING_API_RESPONSE" } });
    client.emit({ type: "stream_delta", runtime: rt, delta: { message_type: "reasoning_message", reasoning: "hmm" } });
    client.emit({ type: "stream_delta", runtime: rt, delta: { message_type: "assistant_message", content: "Hel" } });
    client.emit({ type: "stream_delta", runtime: rt, delta: { message_type: "assistant_message", content: [{ type: "text", text: "lo" }] } });
    client.emit({ type: "stream_delta", runtime: rt, delta: { message_type: "tool_call_message", tool_call: { name: "Bash" } } });
    client.emit({ type: "stream_delta", runtime: rt, delta: { message_type: "assistant_message", content: " done" } });
    client.emit({ type: "update_loop_status", runtime: rt, loop_status: { status: "WAITING_ON_INPUT" } });
    expect(types()).toEqual([
      `${scope}:chat_state:thinking`,
      `${scope}:chat_state:streaming`,
      `${scope}:chat_delta`,
      `${scope}:chat_delta`,
      `${scope}:chat_done`, // tool call closes the first bubble
      `${scope}:chat_state:thinking`,
      `${scope}:chat_tool`, // …and shows up as a marker
      `${scope}:chat_state:streaming`,
      `${scope}:chat_delta`,
      `${scope}:chat_done`,
      `${scope}:chat_state:idle`,
    ]);
    expect(frames.filter(([, f]) => f.type === "chat_delta").map(([, f]) => f.text)).toEqual(["Hel", "lo", " done"]);
  });

  test("events for other conversations are ignored", async () => {
    const { client, chat, frames } = harness();
    await chat.attach(scope);
    client.emit({ type: "stream_delta", runtime: { agent_id: "a", conversation_id: "elsewhere" }, delta: { message_type: "assistant_message", content: "x" } });
    expect(frames).toEqual([]);
  });

  test("send submits input, marks thinking, and its user_message echo is not shown twice", async () => {
    const { client, chat, frames, types } = harness();
    await chat.send(scope, "hello there");
    expect(client.sent).toEqual([{ rt, text: "hello there" }]);
    expect(types()).toEqual([`${scope}:chat_state:thinking`]);
    client.emit({ type: "stream_delta", runtime: rt, delta: { message_type: "user_message", content: "hello there" } });
    expect(frames.filter(([, f]) => f.type === "chat_user")).toEqual([]);
    // a message typed in Desktop, carrying our attached desk block, shows up cleaned
    client.emit({ type: "stream_delta", runtime: rt, delta: { message_type: "user_message", content: 'from desktop\n\n<loci-desk desk="x">\n- moved a\n</loci-desk>' } });
    expect(frames.filter(([, f]) => f.type === "chat_user").map(([, f]) => f.text)).toEqual(["from desktop"]);
  });

  test("send on an unbound desk reports an error", async () => {
    const { chat, frames } = harness();
    await chat.send("nowhere", "hi");
    expect(frames[0][1]).toMatchObject({ type: "chat_error" });
  });
});
