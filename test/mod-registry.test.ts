import { describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { AgentStore } from "../daemon/kernel/index.ts";
import { ModRegistry } from "../daemon/mods/registry.ts";
import { fromLettaMod } from "../daemon/mods/letta-facade.ts";
import type { LokiMod, ModTool } from "../daemon/mods/api.ts";

const ctx = BACKGROUND_CONTEXT;

/** An agent's store on memory, with a faux model whose requests are recorded, over `mods`. */
async function setup(mods: ModRegistry, agent = { id: "agent-local-a", name: "Ada" }) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const sent: string[] = [];
  const record = (reply: ReturnType<typeof fauxAssistantMessage>) => (context: { systemPrompt?: string; messages: unknown[] }) => {
    sent.push(JSON.stringify(context));
    return reply;
  };
  const store = await AgentStore.open({ storage: new MemoryStorage() }, { models, registry: mods.registry }, ctx);
  await store.setAgent(agent, ctx);
  const model = { provider: faux.provider.id, modelId: faux.getModel().id };
  return { store, faux, sent, record, model };
}

const echoTool = (seen: unknown[], label = "v1"): ModTool => ({
  name: "echo",
  description: "Echo the chat you were called from",
  parameters: { type: "object", properties: { word: { type: "string" } }, required: ["word"] },
  execute: (args, c) => {
    seen.push({ args, chatId: c.chatId, agentId: c.agentId });
    return `${label}:${String(args.word)}`;
  },
});

const toolTurn = (word: string) => fauxAssistantMessage(fauxToolCall("echo", { word }), { stopReason: "toolUse" });

/** The text of every tool result in a chat. */
async function results(store: AgentStore, chatId: string) {
  const chat = (await store.chat(chatId, ctx))!;
  return (await store.entries(chat, ctx)).filter((e) => e.kind === "pi.tool-result").map((e) => JSON.stringify(e.model));
}

describe("mod registry", () => {
  test("a mod's tool, prompt section and before-tool hook reach a chat, with loki's chat and agent ids", async () => {
    const mods = new ModRegistry(() => {});
    const seen: unknown[] = [];
    const calls: string[] = [];
    const mod: LokiMod = {
      name: "demo",
      apiVersion: 1,
      activate: (api) => {
        api.tools.register(echoTool(seen));
        api.prompt.section("demo", (input) => `chat ${input.chatId} of ${input.agentName}`);
        api.beforeTool((call) => {
          calls.push(`${call.name}@${call.chatId}`);
          return call.args.word === "forbidden" ? { block: "not that word" } : undefined;
        });
      },
    };
    expect(await mods.load(mod)).toEqual({ loaded: true });
    const { store, faux, sent, record, model } = await setup(mods);
    try {
      const chat = await store.createChat("local-conv-1", { agent: { model } }, ctx);
      faux.setResponses([record(toolTurn("hello")), record(toolTurn("forbidden")), record(fauxAssistantMessage("done"))]);
      await (await chat.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
      expect(seen).toEqual([{ args: { word: "hello" }, chatId: "local-conv-1", agentId: "agent-local-a" }]);
      expect(calls).toEqual(["echo@local-conv-1", "echo@local-conv-1"]);
      const out = await results(store, "local-conv-1");
      expect(out[0]).toContain("v1:hello");
      expect(out[1]).toContain("not that word");
      expect(sent[0]).toContain("chat local-conv-1 of Ada");
    } finally {
      await store.close(ctx);
    }
  });

  test("loading a mod again under its name replaces it: the next call runs the new code, and the old one is undone", async () => {
    const mods = new ModRegistry(() => {});
    const seen: unknown[] = [];
    let undone = 0;
    const version = (label: string): LokiMod => ({
      name: "demo",
      apiVersion: 1,
      activate: (api) => {
        api.tools.register(echoTool(seen, label));
        return () => undone++;
      },
    });
    await mods.load(version("v1"));
    const { store, faux, record, model } = await setup(mods);
    try {
      const chat = await store.createChat("c", { agent: { model } }, ctx);
      faux.setResponses([record(toolTurn("a")), record(fauxAssistantMessage("ok"))]);
      await (await chat.submit({ type: "input", content: "first" }, ctx)).wait(ctx);
      await mods.load(version("v2"));
      expect(undone).toBe(1);
      faux.setResponses([record(toolTurn("b")), record(fauxAssistantMessage("ok"))]);
      await (await chat.submit({ type: "input", content: "second" }, ctx)).wait(ctx);
      const out = await results(store, "c");
      expect(out[0]).toContain("v1:a");
      expect(out[1]).toContain("v2:b");
      expect(mods.names()).toEqual(["demo"]);
    } finally {
      await store.close(ctx);
    }
  });

  test("a mod built for a newer mod API is refused and reported", async () => {
    const reports: string[] = [];
    const mods = new ModRegistry((m) => reports.push(m));
    const result = await mods.load({ name: "future", apiVersion: 2, activate: () => {} });
    expect(result).toEqual({ refused: expect.stringContaining("needs mod API 2") });
    expect(reports[0]).toContain("future");
    expect(mods.names()).toEqual([]);
  });

  test("a mod that throws while loading is reported, and the mods already loaded keep working", async () => {
    const reports: string[] = [];
    const mods = new ModRegistry((m) => reports.push(m));
    await mods.load({ name: "good", apiVersion: 1, activate: (api) => void api.tools.register(echoTool([])) });
    const result = await mods.load({ name: "bad", apiVersion: 1, activate: () => { throw new Error("boom"); } });
    expect(result).toEqual({ refused: expect.stringContaining("boom") });
    expect(mods.names()).toEqual(["good"]);
    expect(mods.registry.snapshot().tools().map((t) => t.tool.name)).toEqual(["echo"]);
  });

  test("one load reaches the chats of two agents' stores", async () => {
    const mods = new ModRegistry(() => {});
    const seen: Array<{ agentId: string }> = [];
    await mods.load({ name: "demo", apiVersion: 1, activate: (api) => void api.tools.register(echoTool(seen as unknown[])) });
    const a = await setup(mods, { id: "agent-local-a", name: "Ada" });
    const b = await setup(mods, { id: "agent-local-b", name: "Bo" });
    try {
      for (const s of [a, b]) {
        const chat = await s.store.createChat("x", { agent: { model: s.model } }, ctx);
        s.faux.setResponses([s.record(toolTurn("w")), s.record(fauxAssistantMessage("ok"))]);
        await (await chat.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
      }
      expect(seen.map((s) => s.agentId)).toEqual(["agent-local-a", "agent-local-b"]);
    } finally {
      await a.store.close(ctx);
      await b.store.close(ctx);
    }
  });

  test("message transforms run in load order, and turn_end reaches listeners when a run answers", async () => {
    const mods = new ModRegistry(() => {});
    const ended: string[] = [];
    await mods.load({ name: "one", apiVersion: 1, activate: (api) => void api.message.transform((m) => `${String(m.content)} +one`) });
    await mods.load({
      name: "two",
      apiVersion: 1,
      activate: (api) => {
        api.message.transform((m) => `${String(m.content)} +two`);
        api.events.on("turn_end", (e) => ended.push(e.chatId));
      },
    });
    expect(mods.transformMessage({ chatId: "c", agentId: "a", agentName: "A", content: "hi", typed: true })).toBe("hi +one +two");
    const { store, faux, record, model } = await setup(mods);
    try {
      const chat = await store.createChat("c", { agent: { model } }, ctx);
      faux.setResponses([record(fauxAssistantMessage("ok"))]);
      await (await chat.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
      expect(ended).toEqual(["c"]);
    } finally {
      await store.close(ctx);
    }
  });
});

describe("Letta facade", () => {
  test("a mod written for Letta's API registers its tools and rides its turn_start on the person's message", async () => {
    const mods = new ModRegistry(() => {});
    const runs: unknown[] = [];
    const lettaMod = fromLettaMod("core", (letta) => {
      letta.tools.register({
        name: "desk_state",
        description: "The desk",
        parameters: { type: "object", properties: {} },
        run: (c) => {
          runs.push({ conversation: c.conversation.id, agent: c.agent });
          return { widgets: [] };
        },
      });
      letta.tools.register({ name: "loki_camera", description: "The camera", parameters: { type: "object", properties: {} }, run: () => ({ status: "error", content: "give widgetId or widgetIds" }) });
      letta.events.on("turn_start", (event) => {
        const ev = event as { conversationId: string; input: Array<{ role: string; content: unknown }> };
        const last = ev.input.at(-1)!;
        return { input: [{ ...last, content: `${String(last.content)}\n\n<loki-desk desk="${ev.conversationId}"/>` }] };
      });
    });
    await mods.load(lettaMod);
    expect(mods.transformMessage({ chatId: "local-conv-9", agentId: "a", agentName: "A", content: "hello", typed: true })).toBe('hello\n\n<loki-desk desk="local-conv-9"/>');
    const { store, faux, record, model } = await setup(mods);
    try {
      const chat = await store.createChat("local-conv-9", { agent: { model } }, ctx);
      faux.setResponses([record(fauxAssistantMessage([fauxToolCall("desk_state", {}), fauxToolCall("loki_camera", {})], { stopReason: "toolUse" })), record(fauxAssistantMessage("ok"))]);
      await (await chat.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
      expect(runs).toEqual([{ conversation: "local-conv-9", agent: { id: "agent-local-a", name: "Ada" } }]);
      const [desk, camera] = await results(store, "local-conv-9");
      expect(desk).toContain("widgets");
      // Letta's error result reaches the model as a failed call, with its message.
      expect(camera).toContain("give widgetId or widgetIds");
      expect(camera).not.toContain('"status"');
    } finally {
      await store.close(ctx);
    }
  });
});
