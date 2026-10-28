import { describe, expect, test } from "vitest";
import { chatFrames, type ChatBackend } from "../mod/frames/chat.ts";
import type { FrameContext } from "../mod/frames/context.ts";
import { FrameChatClient } from "../core/attention/chat-client.ts";
import { must } from "./fixtures/must.ts";

/** An agent changed: every client hears it (agents_changed), not only the one that changed it. */

const ctx = () => {
  const broadcasts: Array<{ type: string }> = [];
  const c = {
    client: { scope: "s", send: () => {} },
    push: () => {},
    broadcast: (f: { type: string }) => broadcasts.push(f),
    track: () => {},
  } as unknown as FrameContext;
  return { c, broadcasts };
};

const backend = (fail = false) =>
  ({
    createAgent: async () => (fail ? Promise.reject(new Error("no")) : { id: "agent-local-new", name: "test" }),
    updateAgent: async () => (fail ? Promise.reject(new Error("no")) : undefined),
    deleteAgent: async () => (fail ? Promise.reject(new Error("no")) : undefined),
    agents: () => Promise.resolve([]),
  }) as unknown as ChatBackend;

describe("agents_changed", () => {
  test("creating, renaming and deleting agents each tell every client once it is done", async () => {
    const h = chatFrames({ chat: backend() });
    const calls: Array<[string, () => Promise<unknown>]> = [];
    const { c, broadcasts } = ctx();
    calls.push(["create", () => Promise.resolve(must(h.chat_agent_create, "the chat_agent_create handler")({ name: "test" } as never, c))]);
    calls.push([
      "update",
      () => Promise.resolve(must(h.chat_agent_update, "the chat_agent_update handler")({ agent_id: "agent-local-a", name: "test" } as never, c)),
    ]);
    calls.push(["delete", () => Promise.resolve(must(h.chat_agent_delete, "the chat_agent_delete handler")({ agent_id: "agent-local-a" }, c))]);
    for (const [, call] of calls) expect(await call()).toMatchObject({ ok: true });
    expect(broadcasts).toEqual([{ type: "agents_changed" }, { type: "agents_changed" }, { type: "agents_changed" }]);
  });

  test("a change that failed tells no one, and reading the agents is not a change", async () => {
    const { c, broadcasts } = ctx();
    const failing = chatFrames({ chat: backend(true) });
    expect(await must(failing.chat_agent_update, "the chat_agent_update handler")({ agent_id: "agent-local-a", name: "x" } as never, c)).toMatchObject({
      ok: false,
    });
    expect(await must(failing.chat_agent_create, "the chat_agent_create handler")({ name: "x" } as never, c)).toMatchObject({ ok: false });
    expect(await must(chatFrames({ chat: backend() }).chat_agents, "the chat_agents handler")({}, c)).toMatchObject({ ok: true });
    expect(broadcasts).toEqual([]);
  });

  test("the chat client passes the word on to whoever holds the lists, until they stop listening", () => {
    let stale: (() => void) | null = null;
    const client = new FrameChatClient({
      request: (() => Promise.resolve({ ok: true, reply: {} })) as never,
      onChatEvent: () => () => {},
      onListsStale: (fn) => ((stale = fn), () => (stale = null)),
    });
    let heard = 0;
    const off = client.onListsStale(() => heard++);
    must<() => void>(stale, "the stale listener")();
    must<() => void>(stale, "the stale listener")();
    expect(heard).toBe(2);
    off();
    must<() => void>(stale, "the stale listener")();
    expect(heard).toBe(2);
    client.close();
    expect(stale).toBeNull(); // closing the client lets go of the socket's signal too
  });
});
