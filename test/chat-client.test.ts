import { describe, expect, test } from "bun:test";
import { FrameChatClient, type FrameRequest } from "../core/attention/chat-client.ts";
import type { ChatEvent } from "../core/attention/model.ts";

describe("the daemon's chat client", () => {
  test("when the socket comes back after a drop, every chat it follows is opened again, and its state now arrives", async () => {
    const opened: string[] = [];
    let loop: "running" | "idle" = "running";
    const request = (async (type: string, payload: Record<string, unknown>) => {
      if (type !== "chat_open") return { ok: false, error: "unexpected" };
      opened.push(String(payload.conversationId));
      return { ok: true, reply: { agentId: payload.agentId, conversationId: payload.conversationId, loop, mode: "unrestricted", cwd: null } };
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
});
