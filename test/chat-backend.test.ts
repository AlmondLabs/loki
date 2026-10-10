import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { DaemonChats, modelRef } from "../daemon/chat-backend.ts";
import { Approvals } from "../daemon/approvals.ts";
import { KeychainCredentials, memorySecrets } from "../daemon/credentials.ts";
import { Providers } from "../daemon/providers.ts";
import { AgentStore } from "../daemon/kernel/index.ts";
import { StoreManager } from "../daemon/kernel/stores.ts";
import { ModRegistry } from "../daemon/mods/registry.ts";
import type { ChatEvent } from "../core/attention/model.ts";

const ctx = BACKGROUND_CONTEXT;

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "loki-chat-backend-"));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const mods = new ModRegistry(() => {});
  await mods.load({ name: "rider", apiVersion: 1, activate: (api) => void api.message.transform((m) => (typeof m.content === "string" ? `${m.content}\n<loki-desk/>` : m.content)) });
  const stores = new StoreManager(join(dir, "stores"), { models, registry: mods.registry }, ctx, () => {}, () => AgentStore.open({ storage: new MemoryStorage() }, { models, registry: mods.registry }, ctx));
  const approvals = new Approvals();
  const providers = new Providers(models, new KeychainCredentials(memorySecrets()));
  const chats = new DaemonChats({ stores, mods, approvals, providers, models, backendDir: join(dir, "backend"), context: ctx });
  const pushed: Array<{ conversationId: string; events: ChatEvent[] }> = [];
  chats.attach((_agentId, conversationId, events) => pushed.push({ conversationId, events }));
  const sent: string[] = [];
  const reply = (text: string) => (context: { messages: unknown[] }) => {
    sent.push(JSON.stringify(context.messages));
    return fauxAssistantMessage(text);
  };
  const handle = `${faux.provider.id}/${faux.getModel().id}`;
  const cleanup = async () => {
    await stores.closeAll();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, faux, chats, pushed, sent, reply, handle, stores, cleanup };
}

const until = async (check: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
};

const kinds = (pushed: Array<{ events: ChatEvent[] }>) => pushed.flatMap((p) => p.events.map((e) => (e.kind === "step" ? `step:${e.step.kind}` : e.kind)));

describe("the daemon's chats", () => {
  test("a new agent comes with its main chat; a new chat opens idle, and a message streams back to every client", async () => {
    const s = await setup();
    try {
      const agent = await s.chats.createAgent({ name: "Ada", description: null, persona: null, model: s.handle });
      expect(await s.chats.agents()).toEqual([{ id: agent.id, name: "Ada" }]);
      // With no persona of yours, the agent's memory starts with its name; with one, with your words.
      expect(readFileSync(join(s.dir, "backend", "memfs", agent.id, "memory", "system", "persona.md"), "utf8")).toBe("I am Ada.\n");
      const told = await s.chats.createAgent({ name: "Bo", description: "reviews pull requests", persona: "  A careful reviewer who asks before changing code.  ", model: s.handle });
      expect(readFileSync(join(s.dir, "backend", "memfs", told.id, "memory", "system", "persona.md"), "utf8")).toBe("A careful reviewer who asks before changing code.\n");
      expect(await (await s.stores.get(agent.id)).chat("default", ctx)).toBeDefined();
      const { conversationId } = await s.chats.create(agent.id, "/work", "Plans");
      expect(await s.chats.open(agent.id, conversationId)).toEqual({ agentId: agent.id, conversationId, loop: "idle", turnId: null, mode: "unrestricted", cwd: "/work" });
      s.faux.setResponses([s.reply("Hello back")]);
      expect(await s.chats.send({ agentId: agent.id, conversationId, text: "hello", images: [], sendId: "s1", context: null })).toBe(true);
      await until(() => kinds(s.pushed).includes("turn_end"));
      expect(kinds(s.pushed)).toEqual(expect.arrayContaining(["loop", "step:user", "step:assistant", "settle", "turn_end"]));
      // The rider every mod adds reached the model.
      expect(s.sent[0]).toContain("hello\\n<loki-desk/>");
    } finally {
      await s.cleanup();
    }
  });

  test("a message sent while the chat runs waits its turn, and one sent again with its sendId goes once", async () => {
    const s = await setup();
    try {
      const agent = await s.chats.createAgent({ name: "Ada", description: null, persona: null, model: s.handle });
      const { conversationId } = await s.chats.create(agent.id, null, null);
      await s.chats.open(agent.id, conversationId);
      s.faux.setResponses([s.reply("one"), s.reply("two")]);
      const send = (text: string, sendId: string) => s.chats.send({ agentId: agent.id, conversationId, text, images: [], sendId, context: null });
      await send("first", "a");
      await send("second", "b");
      await send("second", "b");
      await until(() => kinds(s.pushed).filter((k) => k === "turn_end").length === 2);
      await new Promise((r) => setTimeout(r, 50));
      expect(s.sent).toHaveLength(2);
      expect(s.sent[1]).toContain("second");
      expect(s.sent[1].match(/second/g)).toHaveLength(1);
    } finally {
      await s.cleanup();
    }
  });

  test("moving a chat's folder pushes the new folder; its model and title change; deleting an agent removes it all", async () => {
    const s = await setup();
    try {
      const agent = await s.chats.createAgent({ name: "Ada", description: null, persona: null, model: s.handle });
      const { conversationId } = await s.chats.create(agent.id, "/a", null);
      expect((await s.chats.folder(agent.id, conversationId, "/b")).cwd).toBe("/b");
      expect(s.pushed.at(-1)).toEqual({ conversationId, events: [{ kind: "device", cwd: "/b" }] });
      await s.chats.model({ agentId: agent.id, conversationId, handle: s.handle, reasoningEffort: "high" });
      const store = await s.stores.get(agent.id);
      const chat = (await store.chat(conversationId, ctx))!;
      expect(await store.agentSettings(chat.id, ctx)).toMatchObject({ model: modelRef(s.handle), thinkingLevel: "high", cwd: "/b" });
      await s.chats.update({ agentId: agent.id, conversationId, title: "Renamed", archived: true, hidden: undefined });
      expect((await store.chats(ctx)).find((c) => c.id === conversationId)).toMatchObject({ title: "Renamed", archived: true });
      await s.chats.updateAgent({ agentId: agent.id, name: "Ada Lovelace", description: undefined, model: undefined });
      expect(await s.chats.agents()).toEqual([{ id: agent.id, name: "Ada Lovelace" }]);
      await s.chats.deleteAgent(agent.id);
      expect(await s.chats.agents()).toEqual([]);
      expect(existsSync(join(s.dir, "backend", "memfs", agent.id))).toBe(false);
    } finally {
      await s.cleanup();
    }
  });

  test("slash commands: /remember asks the agent, /clear starts it afresh, /compact summarises, and others are refused", async () => {
    const s = await setup();
    try {
      const agent = await s.chats.createAgent({ name: "Ada", description: null, persona: null, model: s.handle });
      const { conversationId } = await s.chats.create(agent.id, null, null);
      await s.chats.open(agent.id, conversationId);
      const run = (command: string, args: string | null = null) => s.chats.command({ agentId: agent.id, conversationId, command, args });
      s.faux.setResponses([s.reply("noted"), s.reply("fresh")]);
      expect((await run("remember", "I like tea")).success).toBe(true);
      await until(() => kinds(s.pushed).includes("turn_end"));
      expect(s.sent[0]).toContain("Please remember this in your memory: I like tea");
      // A chat this short has nothing old enough to summarise: /compact is accepted and leaves it as it is.
      expect((await run("compact")).success).toBe(true);
      expect((await run("clear")).success).toBe(true);
      await s.chats.send({ agentId: agent.id, conversationId, text: "hello again", images: [], sendId: "x", context: null });
      await until(() => s.sent.length === 2);
      expect(s.sent[1]).toContain("hello again");
      expect(s.sent[1]).not.toContain("I like tea");
      expect(await run("doctor")).toEqual({ success: false, output: "/doctor is not a command loki's daemon runs" });
    } finally {
      await s.cleanup();
    }
  });

  test("Learn's ask runs in a hidden chat of its own, made once, and hands back the agent's whole reply", async () => {
    const s = await setup();
    try {
      const agent = await s.chats.createAgent({ name: "Ada", description: null, persona: null, model: s.handle });
      s.faux.setResponses([s.reply("first card"), s.reply("second card")]);
      expect(await s.chats.ask(agent.id, `recall-${agent.id}`, "write a card", null)).toBe("first card");
      expect(await s.chats.ask(agent.id, `recall-${agent.id}`, "another", null)).toBe("second card");
      const store = await s.stores.get(agent.id);
      expect((await store.chatInfo((await store.chat(`recall-${agent.id}`, ctx))!.id, ctx))?.hidden).toBe(true);
      expect(s.sent[1]).toContain("write a card"); // the second ask follows the first in the same chat
    } finally {
      await s.cleanup();
    }
  });

  test("a chat whose model carries Letta's name for it is renamed and answered", async () => {
    const s = await setup();
    try {
      const agent = await s.chats.createAgent({ name: "Ada", description: null, persona: null, model: s.handle });
      const store = await s.stores.get(agent.id);
      await store.createChat("imported", { agent: { model: { provider: "chatgpt-plus-pro", modelId: s.handle } } }, ctx);
      await s.chats.open(agent.id, "imported");
      s.faux.setResponses([s.reply("answered")]);
      await s.chats.send({ agentId: agent.id, conversationId: "imported", text: "hi", images: [], sendId: "h1", context: null });
      await until(() => kinds(s.pushed).includes("turn_end"));
      expect(s.pushed.flatMap((p) => p.events).some((e) => e.kind === "error")).toBe(false);
      const chat = (await store.chat("imported", ctx))!;
      expect(((await store.agentSettings(chat.id, ctx)) as { model?: { provider: string } }).model?.provider).toBe(s.faux.provider.id);
    } finally {
      await s.cleanup();
    }
  });

  test("a message into a chat no client opened since the daemon started is still heard: its events go out", async () => {
    const s = await setup();
    try {
      const agent = await s.chats.createAgent({ name: "Ada", description: null, persona: null, model: s.handle });
      const { conversationId } = await s.chats.create(agent.id, null, null);
      // No open: a client that opened the chat before a restart sends straight away.
      s.faux.setResponses([s.reply("still heard")]);
      await s.chats.send({ agentId: agent.id, conversationId, text: "hi", images: [], sendId: "r1", context: null });
      await until(() => kinds(s.pushed).includes("turn_end"));
      expect(kinds(s.pushed)).toEqual(expect.arrayContaining(["step:assistant", "turn_end"]));
    } finally {
      await s.cleanup();
    }
  });

  test("an image sent with a message reaches the model as an image part", async () => {
    const s = await setup();
    try {
      const agent = await s.chats.createAgent({ name: "Ada", description: null, persona: null, model: s.handle });
      const { conversationId } = await s.chats.create(agent.id, null, null);
      await s.chats.open(agent.id, conversationId);
      s.faux.setResponses([s.reply("a cat")]);
      await s.chats.send({ agentId: agent.id, conversationId, text: "what is this?", images: [{ data: "aGVsbG8=", mediaType: "image/png" }], sendId: "i1", context: null });
      await until(() => kinds(s.pushed).includes("turn_end"));
      expect(s.sent[0]).toContain('"type":"image"');
      expect(s.sent[0]).toContain('"mimeType":"image/png"');
    } finally {
      await s.cleanup();
    }
  });

  test("the models on offer carry their provider in the handle", async () => {
    const s = await setup();
    try {
      expect((await s.chats.models()).map((m) => m.handle)).toContain(s.handle);
    } finally {
      await s.cleanup();
    }
  });

  test("a chat that does not exist is refused, and a handle without a provider is not a model", async () => {
    const s = await setup();
    try {
      const agent = await s.chats.createAgent({ name: "Ada", description: null, persona: null, model: null });
      await expect(s.chats.open(agent.id, "nope")).rejects.toThrow("no chat nope");
      expect(modelRef("gpt")).toBeUndefined();
      expect(modelRef("openrouter/~anthropic/claude-haiku-latest")).toEqual({ provider: "openrouter", modelId: "~anthropic/claude-haiku-latest" });
    } finally {
      await s.cleanup();
    }
  });
});
