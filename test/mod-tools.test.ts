import { describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { AgentStore } from "../daemon/kernel/index.ts";
import { ModRegistry } from "../daemon/mods/registry.ts";
import type { ModTool } from "../daemon/mods/api.ts";

const ctx = BACKGROUND_CONTEXT;

const tool = (name: string, forAgent?: (agentId: string) => boolean): ModTool => ({
  name,
  description: `The ${name} tool`,
  parameters: { type: "object", properties: {} },
  execute: () => name,
  ...(forAgent ? { forAgent } : {}),
});

/** A mod with one tool for everyone and one for the agents in `allowed`, and a chat of each of two agents on loki's engine. */
async function setup(allowed: Set<string>) {
  const mods = new ModRegistry(() => {});
  await mods.load({
    name: "accounts",
    apiVersion: 1,
    activate: (api) => {
      api.tools.register(tool("everyone"));
      api.tools.register(tool("account_read", (agentId) => allowed.has(agentId)));
    },
  });
  const models = createModels();
  const open = async (id: string, name: string) => {
    const store = await AgentStore.open({ storage: new MemoryStorage() }, { models, registry: mods.registry }, ctx);
    await store.setAgent({ id, name }, ctx);
    const chat = await store.createChat(`local-conv-${name.toLowerCase()}`, { title: null }, ctx);
    return { store, chat };
  };
  const a = await open("agent-local-ada", "Ada");
  const b = await open("agent-local-bo", "Bo");
  /** The mod tools a chat's next turn offers, after loki's engine readies it. */
  const offered = async (c: typeof a) => {
    await mods.prepare(c.store, c.chat, ctx);
    return (await c.chat.agent(ctx)).tools.map((t) => t.name).filter((n) => n === "everyone" || n === "account_read");
  };
  const close = async () => {
    await a.store.close(ctx);
    await b.store.close(ctx);
  };
  return { a, b, offered, close };
}

describe("per-agent mod tools on loki's engine (plan 067, U1)", () => {
  test("a tool without forAgent is offered to every agent's chat; one for agent A only is offered in A's chats and not B's", async () => {
    const s = await setup(new Set(["agent-local-ada"]));
    try {
      expect(await s.offered(s.a)).toEqual(["everyone", "account_read"]);
      expect(await s.offered(s.b)).toEqual(["everyone"]);
    } finally {
      await s.close();
    }
  });

  test("what forAgent answers decides the next turn's list", async () => {
    const allowed = new Set(["agent-local-ada"]);
    const s = await setup(allowed);
    try {
      expect(await s.offered(s.b)).toEqual(["everyone"]);
      allowed.add("agent-local-bo");
      allowed.delete("agent-local-ada");
      expect(await s.offered(s.b)).toEqual(["everyone", "account_read"]);
      expect(await s.offered(s.a)).toEqual(["everyone"]);
    } finally {
      await s.close();
    }
  });

  test("tools hidden from the chat by someone else (MCP's filter) stay hidden", async () => {
    const s = await setup(new Set());
    try {
      await s.b.chat.configure({ tools: { remove: [{ name: "mcp__fake__list_issues" } as never] } }, ctx);
      await s.offered(s.b);
      // The script tool is every chat's (plan 099), so it is not hidden here, though none of this agent's mod tools is
      // script-only.
      expect(await s.b.store.agentSettings(s.b.chat.id, ctx)).toMatchObject({ tools: { remove: ["mcp__fake__list_issues", "account_read"] } });
    } finally {
      await s.close();
    }
  });
});
