import { describe, expect, test } from "vitest";
import { FrameChatClient, type FrameRequest } from "../core/attention/chat-client.ts";
import type { ChatEvent } from "../core/attention/model.ts";

describe("the daemon's chat client", () => {
  test("when the socket comes back after a drop, every chat it follows is opened again, and its state now arrives", async () => {
    const opened: string[] = [];
    let loop: "running" | "idle" = "running";
    const request = ((type: string, payload: Record<string, unknown>) => {
      if (type !== "chat_open") return Promise.resolve({ ok: false, error: "unexpected" });
      opened.push(String(payload.conversation_id));
      return Promise.resolve({
        ok: true,
        reply: { agent_id: payload.agent_id, conversation_id: payload.conversation_id, loop, mode: "unrestricted", cwd: null },
      });
    }) as unknown as FrameRequest;
    let reconnect = () => {};
    const client = new FrameChatClient({ request, onChatEvent: () => () => {}, onReconnect: (fn) => ((reconnect = fn), () => {}) });
    const seen: Array<[string, ChatEvent[]]> = [];
    client.onChat((rt, events) => seen.push([rt.conversation_id, events]));
    await client.runtimeStart({ agent_id: "a", conversation_id: "c1" });
    await client.runtimeStart({ agent_id: "a", conversation_id: "c2" });
    expect(opened).toEqual(["c1", "c2"]);
    // The turn in c1 ended while the socket was down: reopening says so.
    loop = "idle";
    seen.length = 0;
    reconnect();
    await new Promise((r) => setTimeout(r, 10));
    expect(opened.slice(2).sort()).toEqual(["c1", "c2"]);
    expect(seen.find(([c]) => c === "c1")?.[1][0]).toEqual({ kind: "loop", state: "idle" });
    expect(client.isSubscribed({ agent_id: "a", conversation_id: "c1" })).toBe(true);
  });

  test("an update carries the purpose line and a cleared draft to chat_update, and leaves out what it was not given", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const request = ((type: string, payload: Record<string, unknown>) => {
      if (type !== "chat_update") return Promise.resolve({ ok: false, error: "unexpected" });
      sent.push(payload);
      return Promise.resolve({ ok: true, reply: {} });
    }) as unknown as FrameRequest;
    const client = new FrameChatClient({ request, onChatEvent: () => () => {}, agentOf: () => "a" });
    await client.updateConversation("c1", { purpose: "the website" });
    await client.updateConversation("c1", { purpose: null, draft: null });
    await client.updateConversation("c1", { summary: "named", draft: { text: "not from the app" } });
    expect(sent).toEqual([
      { agent_id: "a", conversation_id: "c1", purpose: "the website" },
      { agent_id: "a", conversation_id: "c1", purpose: null, draft: null },
      { agent_id: "a", conversation_id: "c1", title: "named" },
    ]);
  });
});
