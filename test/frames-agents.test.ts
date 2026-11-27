import { describe, expect, test } from "vitest";
import type { AgentsDeps } from "../mod/frames/agents.ts";
import type { LanDeps } from "../mod/frames/lan.ts";
import type { ChatBackend } from "../mod/frames/chat.ts";
import type { PayloadOf } from "../core/frames.ts";
import { FrameChatClient } from "../core/attention/chat-client.ts";
import { bridgeWith, client, settled } from "./fixtures/frames.ts";

describe("agent and phone-listener frames", () => {
  test("an agent page whose memory tree cannot be read answers error, not silence", async () => {
    const agents = {
      get: () => ({ id: "agent-1", name: "ira" }),
      tree: () => {
        throw new Error("memory is not a git repo");
      },
      skills: () => [],
      hasProfile: () => false,
      read: () => null,
      log: () => Promise.resolve([]),
      diff: () => Promise.resolve(""),
    } as unknown as NonNullable<AgentsDeps["agents"]>;
    const { bridge } = bridgeWith({ agents });
    const c = client("d1");
    bridge.onMessage(c, { type: "agent_get", request_id: "r1", agent_id: "agent-1" });
    await settled();
    expect(c.sent.at(-1)).toEqual({ type: "error", request_id: "r1", message: "memory is not a git repo" });
  });

  test("a listener refresh that fails answers an error push", async () => {
    const lan = {
      refresh: () => Promise.reject(new Error("tailscale hung")),
    } as unknown as NonNullable<LanDeps["lan"]>;
    const { bridge } = bridgeWith({ lan });
    const c = client("d1");
    bridge.onMessage(c, { type: "lan_get" });
    await settled();
    expect(c.sent.at(-1)).toEqual({ type: "error", message: "tailscale hung" });
  });
});

describe("an agent's advisor model", () => {
  const AGENT = "agent-local-11111111-1111-4111-8111-111111111111";
  const backend = (updates: Array<PayloadOf<"chat_agent_update">>) =>
    ({ updateAgent: (p: PayloadOf<"chat_agent_update">) => (updates.push(p), Promise.resolve()), model: () => Promise.resolve() }) as unknown as ChatBackend;

  test("one of loki's models is saved with its effort; an ACP agent's is refused with the reason", async () => {
    const updates: Array<PayloadOf<"chat_agent_update">> = [];
    const { bridge } = bridgeWith({ chat: backend(updates) });
    const c = client("d1");
    bridge.onMessage(c, { type: "chat_agent_update", request_id: "r1", agent_id: AGENT, model: "openai/gpt-6.1-sol" });
    await settled();
    expect(c.sent.at(-1)).toMatchObject({ type: "chat_done", request_id: "r1" });
    expect(updates.at(-1)).toMatchObject({ agent_id: AGENT, model: "openai/gpt-6.1-sol" });
  });

  test("the app updates agent fields cleanly", async () => {
    const sent: unknown[] = [];
    const app = new FrameChatClient({
      request: ((type: string, payload: unknown) => (sent.push({ type, ...(payload as object) }), Promise.resolve({ ok: true, reply: {} }))) as never,
      onChatEvent: () => () => {},
    });
    await app.updateAgent(AGENT, { name: "Friday", description: "Helper", model: "openai/gpt-6.1-sol" });
    expect(sent).toEqual([{ type: "chat_agent_update", agent_id: AGENT, name: "Friday", description: "Helper", model: "openai/gpt-6.1-sol" }]);
    app.close();
  });

  test("a model picked in a subagent chat leaves the agent's usual models alone; the same pick in its chat records it", async () => {
    const recorded: string[] = [];
    const usualModels = { read: () => ({}), record: (agentId: string, handle: string) => (recorded.push(`${agentId} ${handle}`), {}) };
    const { bridge } = bridgeWith({ chat: backend([]), usualModels });
    const c = client("d1");
    bridge.onMessage(c, { type: "chat_model", request_id: "r1", agent_id: AGENT, conversation_id: "c1~subagent~kestrel", handle: "openai/gpt-6.1-sol" });
    await settled();
    expect(c.sent.at(-1)).toMatchObject({ type: "chat_done", request_id: "r1" });
    expect(recorded).toEqual([]);
    bridge.onMessage(c, { type: "chat_model", request_id: "r2", agent_id: AGENT, conversation_id: "c1", handle: "openai/gpt-6.1-sol" });
    await settled();
    expect(recorded).toEqual([`${AGENT} openai/gpt-6.1-sol`]);
  });
});
