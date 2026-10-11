import { describe, expect, test } from "vitest";
import { chatFrames, type ChatBackend } from "../mod/frames/chat.ts";
import type { FrameContext } from "../mod/frames/context.ts";
import { FrameChatClient } from "../core/attention/chat-client.ts";

/** An agent changed: every client hears it (agents_changed), not only the one that changed it. */

const ctx = () => {
  const broadcasts: Array<{ type: string }> = [];
  const c = { client: { scope: "s", send: () => {} }, push: () => {}, broadcast: (f: { type: string }) => broadcasts.push(f), track: () => {} } as unknown as FrameContext;
  return { c, broadcasts };
};

const backend = (fail = false) =>
  ({
    createAgent: async () => (fail ? Promise.reject(new Error("no")) : { id: "agent-local-new", name: "test" }),
    updateAgent: async () => (fail ? Promise.reject(new Error("no")) : undefined),
    deleteAgent: async () => (fail ? Promise.reject(new Error("no")) : undefined),
    importLetta: async () => (fail ? Promise.reject(new Error("no")) : { agents: [], chats: 0, kept: 0, credentials: [], schedules: 0, notes: [] }),
    agents: async () => [],
  }) as unknown as ChatBackend;

describe("agents_changed", () => {
  test("creating, renaming, deleting and importing agents each tell every client once it is done", async () => {
    const h = chatFrames({ chat: backend() });
    const calls: Array<[string, () => Promise<unknown>]> = [];
    const { c, broadcasts } = ctx();
    calls.push(["create", () => h.chat_agent_create!({ name: "test" } as never, c) as Promise<unknown>]);
    calls.push(["update", () => h.chat_agent_update!({ agentId: "agent-local-a", name: "test" } as never, c) as Promise<unknown>]);
    calls.push(["delete", () => h.chat_agent_delete!({ agentId: "agent-local-a" } as never, c) as Promise<unknown>]);
    calls.push(["import", () => h.chat_import!({} as never, c) as Promise<unknown>]);
    for (const [, call] of calls) expect(await call()).toMatchObject({ ok: true });
    expect(broadcasts).toEqual([{ type: "agents_changed" }, { type: "agents_changed" }, { type: "agents_changed" }, { type: "agents_changed" }]);
  });

  test("a change that failed tells no one, and reading the agents is not a change", async () => {
    const { c, broadcasts } = ctx();
    const failing = chatFrames({ chat: backend(true) });
    expect(await failing.chat_agent_update!({ agentId: "agent-local-a", name: "x" } as never, c)).toMatchObject({ ok: false });
    expect(await failing.chat_agent_create!({ name: "x" } as never, c)).toMatchObject({ ok: false });
    expect(await chatFrames({ chat: backend() }).chat_agents!({} as never, c)).toMatchObject({ ok: true });
    expect(broadcasts).toEqual([]);
  });

  test("the chat client passes the word on to whoever holds the lists, until they stop listening", () => {
    let stale: (() => void) | null = null;
    const client = new FrameChatClient({
      request: (async () => ({ ok: true, reply: {} })) as never,
      onChatEvent: () => () => {},
      onListsStale: (fn) => ((stale = fn), () => (stale = null)),
    });
    let heard = 0;
    const off = client.onListsStale(() => heard++);
    stale!();
    stale!();
    expect(heard).toBe(2);
    off();
    stale!();
    expect(heard).toBe(2);
    client.close();
    expect(stale).toBeNull(); // closing the client lets go of the socket's signal too
  });
});
