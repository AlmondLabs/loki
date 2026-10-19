import { describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool, MemoryStorage } from "@earendil-works/pi-durable";
import { DaemonChats, lokiModelEntries } from "../daemon/chat-backend.ts";
import { modelRef } from "../daemon/loki-engine.ts";
import { Approvals } from "../daemon/approvals.ts";
import { KeychainCredentials, memorySecrets } from "../daemon/credentials.ts";
import { Providers } from "../daemon/providers.ts";
import { AgentStore } from "../daemon/kernel/index.ts";
import { StoreManager } from "../daemon/kernel/stores.ts";
import { ModRegistry } from "../daemon/mods/registry.ts";
import { applyChatEvent, emptyLive, type ChatEvent } from "../core/attention/model.ts";
import { must } from "./fixtures/must.ts";

const ctx = BACKGROUND_CONTEXT;

async function setup(
  opts: {
    tokensPerSecond?: number;
    tool?: (done: () => void) => Promise<void>;
    passes?: ConstructorParameters<typeof DaemonChats>[0]["passes"];
    macId?: string;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "loki-chat-backend-"));
  const faux = fauxProvider(opts.tokensPerSecond ? { tokensPerSecond: opts.tokensPerSecond, tokenSize: { min: 3, max: 3 } } : {});
  const models = createModels();
  models.setProvider(faux.provider);
  const mods = new ModRegistry(() => {});
  const tool = opts.tool;
  if (tool)
    mods.registry.install(
      defineExtension({
        name: "t",
        tools: [
          defineTool({
            name: "slow",
            description: "slow",
            parameters: { type: "object", properties: {} } as never,
            execute: async () => (await tool(() => {}), { content: [{ type: "text", text: "slow done" }] }),
          }),
        ],
      }),
    );
  await mods.load({
    name: "rider",
    apiVersion: 1,
    activate: (api) => void api.message.transform((m) => (typeof m.content === "string" ? `${m.content}\n<loki-desk/>` : m.content)),
  });
  const stores = new StoreManager(
    join(dir, "stores"),
    { models, registry: mods.registry },
    ctx,
    () => {},
    () => AgentStore.open({ storage: new MemoryStorage() }, { models, registry: mods.registry }, ctx),
  );
  const approvals = new Approvals();
  const providers = new Providers(models, new KeychainCredentials(memorySecrets()));
  const chats = new DaemonChats({
    stores,
    mods,
    approvals,
    providers,
    models,
    backendDir: join(dir, "backend"),
    context: ctx,
    ...(opts.passes ? { passes: opts.passes } : {}),
    ...(opts.macId ? { macId: opts.macId } : {}),
  });
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
  test("loki's own message steered in while a turn works goes in at its next step, not as a turn after the answer", async () => {
    // A background task ends while the agent is still at work (here, inside a tool call): its notice is delivered then.
    let notice: () => Promise<void> = async () => {};
    const s = await setup({
      tool: async () => {
        await notice();
        await new Promise((r) => setTimeout(r, 200));
      },
    });
    try {
      const agent = await s.chats.createAgent({ name: "Ada", description: null, persona: null, model: s.handle });
      const { conversationId } = await s.chats.create(agent.id, "/work", "Plans");
      await s.chats.open(agent.id, conversationId);
      notice = () =>
        s.chats.deliver(agent.id, conversationId, "<task-notification>\n<task-id>bg-1</task-id>\n<status>completed</status>\n</task-notification>", "steer");
      let asked = 0;
      s.faux.setResponses([
        () => (asked++, fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" })),
        () => (asked++, fauxAssistantMessage("Done.")),
        () => (asked++, fauxAssistantMessage("Extra.")),
      ]);
      await s.chats.send({ agent_id: agent.id, conversation_id: conversationId, text: "go", images: [], send_id: "s1", context: null });
      await until(() => kinds(s.pushed).includes("turn_end"), 10_000);
      await new Promise((r) => setTimeout(r, 300));
      const steps = s.pushed
        .flatMap((p) => p.events)
        .flatMap((e) =>
          e.kind === "step" && (e.step.kind === "user" || (e.step.kind === "assistant" && !e.step.chunk))
            ? [e.step.kind === "user" ? e.step.raw.split("\n")[0] : e.step.text]
            : [],
        );
      expect(steps.filter((t) => t)).toEqual(["go", "<task-notification>", "Done."]);
      expect(kinds(s.pushed).filter((k) => k === "turn_end")).toHaveLength(1);
      expect(asked).toBe(2);
    } finally {
      await s.cleanup();
    }
  });

  test("a client that opens a chat mid-answer gets what was written so far, and draws the reply once, whole", async () => {
    const s = await setup({ tokensPerSecond: 15 });
    try {
      const agent = await s.chats.createAgent({ name: "Ada", description: null, persona: null, model: s.handle });
      const { conversationId } = await s.chats.create(agent.id, "/work", "Plans");
      await s.chats.open(agent.id, conversationId);
      const REPLY = "Keep `farmart-co-read-write-user` for the farmart.co website project. That closes the Dev review.";
      s.faux.setResponses([s.reply(REPLY)]);
      await s.chats.send({ agent_id: agent.id, conversation_id: conversationId, text: "keep it", images: [], send_id: "s1", context: null });
      const chunks = () => s.pushed.flatMap((p) => p.events).filter((e) => e.kind === "step" && e.step.kind === "assistant" && e.step.chunk).length;
      await until(() => chunks() >= 1, 10_000);
      // A second client opens now: the pieces so far went out before it listened.
      const at = s.pushed.length;
      const state = await s.chats.open(agent.id, conversationId);
      expect(state.loop).toBe("running");
      expect(state.streaming?.text.length).toBeGreaterThan(0);
      const streaming = must(state.streaming, "the streaming reply");
      expect(REPLY.startsWith(streaming.text)).toBe(true);
      await until(() => kinds(s.pushed).includes("turn_end"), 10_000);
      // It draws what chat-client makes of the state, then only what was pushed after it opened.
      const l = emptyLive();
      applyChatEvent(l, { kind: "streaming", text: streaming.text, at: streaming.at });
      expect(must(must(l.thread.rows(), "the thread's rows").at(-1), "the last row").text.startsWith("Keep `farm")).toBe(true); // from its first word, while it streams
      for (const p of s.pushed.slice(at)) for (const e of p.events) applyChatEvent(l, e);
      expect(
        must(l.thread.rows(), "the thread's rows")
          .filter((r) => r.role === "assistant")
          .map((r) => r.text),
      ).toEqual([REPLY]);
      expect((await s.chats.open(agent.id, conversationId)).streaming).toBeUndefined(); // nothing in flight once done
    } finally {
      await s.cleanup();
    }
  }, 20_000);

  test("a new agent comes with its main chat; a new chat opens idle, and a message streams back to every client", async () => {
    const s = await setup();
    try {
      const agent = await s.chats.createAgent({ name: "Ada", description: null, persona: null, model: s.handle });
      expect(await s.chats.agents()).toEqual([{ id: agent.id, name: "Ada", home_mac: null }]);
      // With no persona of yours, the agent's memory starts with its name; with one, with your words.
      expect(readFileSync(join(s.dir, "backend", "memfs", agent.id, "memory", "system", "persona.md"), "utf8")).toBe("I am Ada.\n");
      const told = await s.chats.createAgent({
        name: "Bo",
        description: "reviews pull requests",
        persona: "  A careful reviewer who asks before changing code.  ",
        model: s.handle,
      });
      expect(readFileSync(join(s.dir, "backend", "memfs", told.id, "memory", "system", "persona.md"), "utf8")).toBe(
        "A careful reviewer who asks before changing code.\n",
      );
      expect(await (await s.stores.get(agent.id)).chat("default", ctx)).toBeDefined();
      const { conversationId } = await s.chats.create(agent.id, "/work", "Plans");
      expect(await s.chats.open(agent.id, conversationId)).toEqual({
        agent_id: agent.id,
        conversation_id: conversationId,
        loop: "idle",
        turn_id: null,
        mode: "unrestricted",
        cwd: "/work",
      });
      s.faux.setResponses([s.reply("Hello back")]);
      expect(await s.chats.send({ agent_id: agent.id, conversation_id: conversationId, text: "hello", images: [], send_id: "s1", context: null })).toBe(true);
      await until(() => kinds(s.pushed).includes("turn_end"));
      expect(kinds(s.pushed)).toEqual(expect.arrayContaining(["loop", "step:user", "step:assistant", "settle", "turn_end"]));
      // The rider every mod adds reached the model.
      expect(s.sent[0]).toContain("hello\\n<loki-desk/>");
    } finally {
      await s.cleanup();
    }
  });

  test("a message sent while the chat runs waits its turn, and one sent again with its send_id goes once", async () => {
    const s = await setup();
    try {
      const agent = await s.chats.createAgent({ name: "Ada", description: null, persona: null, model: s.handle });
      const { conversationId } = await s.chats.create(agent.id, null, null);
      await s.chats.open(agent.id, conversationId);
      s.faux.setResponses([s.reply("one"), s.reply("two")]);
      const send = (text: string, sendId: string) =>
        s.chats.send({ agent_id: agent.id, conversation_id: conversationId, text, images: [], send_id: sendId, context: null });
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

  test("a message sent with steer while a tool runs joins that turn, read before the agent goes on", async () => {
    let typed = async () => {};
    const s = await setup({
      tool: async () => {
        await typed();
        await new Promise((r) => setTimeout(r, 200));
      },
    });
    try {
      const agent = await s.chats.createAgent({ name: "Ada", description: null, persona: null, model: s.handle });
      const { conversationId } = await s.chats.create(agent.id, "/work", "Plans");
      await s.chats.open(agent.id, conversationId);
      const base = { agent_id: agent.id, conversation_id: conversationId, images: [], context: null };
      typed = () => s.chats.send({ ...base, text: "use pnpm, not npm", send_id: "s2", steer: true }).then(() => {});
      let asked = 0;
      s.faux.setResponses([
        () => (asked++, fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" })),
        (context: { messages: unknown[] }) => (asked++, (seen = JSON.stringify(context.messages)), fauxAssistantMessage("Switched to pnpm.")),
        () => (asked++, fauxAssistantMessage("Extra.")),
      ]);
      let seen = "";
      await s.chats.send({ ...base, text: "install it", send_id: "s1" });
      await until(() => kinds(s.pushed).includes("turn_end"), 10_000);
      await new Promise((r) => setTimeout(r, 300));
      // The agent's next step, in the same turn, read it.
      expect(seen).toContain("use pnpm, not npm");
      expect(kinds(s.pushed).filter((k) => k === "turn_end")).toHaveLength(1);
      expect(asked).toBe(2);
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
      await s.chats.model({ agent_id: agent.id, conversation_id: conversationId, handle: s.handle, reasoning_effort: "high" });
      const store = await s.stores.get(agent.id);
      const chat = must(await store.chat(conversationId, ctx), "the chat");
      expect(await store.agentSettings(chat.id, ctx)).toMatchObject({ model: modelRef(s.handle), thinkingLevel: "high", cwd: "/b" });
      await s.chats.update({ agent_id: agent.id, conversation_id: conversationId, title: "Renamed", archived: true, hidden: undefined, labels: undefined });
      expect((await store.chats(ctx)).find((c) => c.id === conversationId)).toMatchObject({ title: "Renamed", archived: true });
      await s.chats.updateAgent({ agent_id: agent.id, name: "Ada Lovelace", description: undefined, model: undefined, home_mac: undefined });
      expect(await s.chats.agents()).toEqual([{ id: agent.id, name: "Ada Lovelace", home_mac: null }]);
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
      const run = (command: string, args: string | null = null) => s.chats.command({ agent_id: agent.id, conversation_id: conversationId, command, args });
      s.faux.setResponses([s.reply("noted"), s.reply("fresh")]);
      expect((await run("remember", "I like tea")).success).toBe(true);
      await until(() => kinds(s.pushed).includes("turn_end"));
      expect(s.sent[0]).toContain("Please remember this in your memory: I like tea");
      // A chat this short has nothing old enough to summarise: /compact is accepted and leaves it as it is.
      expect((await run("compact")).success).toBe(true);
      expect((await run("clear")).success).toBe(true);
      await s.chats.send({ agent_id: agent.id, conversation_id: conversationId, text: "hello again", images: [], send_id: "x", context: null });
      await until(() => s.sent.length === 2);
      expect(s.sent[1]).toContain("hello again");
      expect(s.sent[1]).not.toContain("I like tea");
      expect(await run("frobnicate")).toEqual({ success: false, output: "/frobnicate is not a command loki's daemon runs" });
      expect(await run("doctor")).toEqual({ success: false, output: "the background passes are not running" });
    } finally {
      await s.cleanup();
    }
  });

  test("/doctor waits for the memory review and answers with its report, and where to see and undo each change", async () => {
    const reviewed: string[] = [];
    const results = [
      { outcome: "changed" as const, changes: 2, report: "- merged two deploy notes\n- the launch has passed" },
      { outcome: "skipped" as const, changes: 0, report: "a memory review of this agent is already running" },
    ];
    const runner = { runDoctor: (agentId: string) => (reviewed.push(agentId), Promise.resolve(must(results.shift(), "a review result"))) };
    const s = await setup({ passes: { runner: runner as never, state: {} as never } });
    try {
      const agent = await s.chats.createAgent({ name: "Ada", description: null, persona: null, model: s.handle });
      const { conversationId } = await s.chats.create(agent.id, null, null);
      const run = () => s.chats.command({ agent_id: agent.id, conversation_id: conversationId, command: "doctor", args: null });
      const done = await run();
      expect(done.success).toBe(true);
      expect(done.output).toBe(
        "- merged two deploy notes\n- the launch has passed\n\n2 changes committed by Doctor; Agents › Changes shows each, and Revert undoes one.",
      );
      expect(await run()).toEqual({ success: false, output: "a memory review of this agent is already running" });
      expect(reviewed).toEqual([agent.id, agent.id]);
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
      await s.chats.send({ agent_id: agent.id, conversation_id: "imported", text: "hi", images: [], send_id: "h1", context: null });
      await until(() => kinds(s.pushed).includes("turn_end"));
      expect(s.pushed.flatMap((p) => p.events).some((e) => e.kind === "error")).toBe(false);
      const chat = must(await store.chat("imported", ctx), "the imported chat");
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
      await s.chats.send({ agent_id: agent.id, conversation_id: conversationId, text: "hi", images: [], send_id: "r1", context: null });
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
      await s.chats.send({
        agent_id: agent.id,
        conversation_id: conversationId,
        text: "what is this?",
        images: [{ data: "aGVsbG8=", media_type: "image/png" }],
        send_id: "i1",
        context: null,
      });
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

  test("a model that reasons is one entry per thinking level pi-ai says it takes, off as no reasoning; one that does not is one entry", () => {
    const base = fauxProvider().getModel();
    const handle = `${base.provider}/${base.id}`;
    const efforts = (m: typeof base) => lokiModelEntries([m]).map((e) => [e.id, e.reasoning_effort ?? null]);
    expect(efforts({ ...base, reasoning: false })).toEqual([[handle, null]]);
    expect(efforts({ ...base, reasoning: true, thinkingLevelMap: { minimal: null, xhigh: "xhigh" } })).toEqual([
      [`${handle}@none`, "none"],
      [`${handle}@low`, "low"],
      [`${handle}@medium`, "medium"],
      [`${handle}@high`, "high"],
      [`${handle}@xhigh`, "xhigh"],
    ]);
    expect(new Set(lokiModelEntries([{ ...base, reasoning: true }]).map((e) => e.handle))).toEqual(new Set([handle]));
  });

  test("max reaches pi as max, and no reasoning as off", async () => {
    const s = await setup();
    try {
      const agent = await s.chats.createAgent({ name: "Ada", description: null, persona: null, model: s.handle });
      const { conversationId } = await s.chats.create(agent.id, null, null);
      const store = await s.stores.get(agent.id);
      const chat = must(await store.chat(conversationId, ctx), "the chat");
      await s.chats.model({ agent_id: agent.id, conversation_id: conversationId, handle: s.handle, reasoning_effort: "max" });
      expect(await store.agentSettings(chat.id, ctx)).toMatchObject({ thinkingLevel: "max" });
      await s.chats.model({ agent_id: agent.id, conversation_id: conversationId, handle: s.handle, reasoning_effort: "none" });
      expect(await store.agentSettings(chat.id, ctx)).toMatchObject({ thinkingLevel: "off" });
    } finally {
      await s.cleanup();
    }
  });

  test("a chat started here with the picker, away from its agent's home, stays out of the hand-over to that home", async () => {
    const s = await setup({ macId: "mac-book" });
    try {
      const agent = await s.chats.createAgent({ name: "Ira", description: null, persona: null, model: s.handle });
      const home = (mac: string) => s.chats.updateAgent({ agent_id: agent.id, name: undefined, description: undefined, model: undefined, home_mac: mac });
      await home("mac-mini");
      const followed = await s.chats.create(agent.id, null, "follows Ira", null);
      const placed = await s.chats.create(agent.id, null, "stays here", "mac-book");
      const ids = (await s.chats.moveCandidates("mac-mini")).map((c) => c.conversation_id);
      expect(ids).toContain(followed.conversationId);
      expect(ids).not.toContain(placed.conversationId);
      // The agent's one main chat goes with it to its new home.
      expect(ids).toContain("default");
      // Picked on the agent's own home, a chat is not placed: it follows the agent like any other.
      await home("mac-book");
      const atHome = await s.chats.create(agent.id, null, "at home", "mac-book");
      await home("mac-mini");
      expect((await s.chats.moveCandidates("mac-mini")).map((c) => c.conversation_id)).toContain(atHome.conversationId);
    } finally {
      await s.cleanup();
    }
  });

  test("after a move the agent is told once, with the next message: the Macs, the files left behind, a missing folder", async () => {
    const s = await setup();
    try {
      const agent = await s.chats.createAgent({ name: "Ada", description: null, persona: null, model: s.handle });
      const { conversationId } = await s.chats.create(agent.id, join(s.dir, "not-here"), null);
      const store = await s.stores.get(agent.id);
      await store.updateChat(conversationId, { moved: { from: "MacBook", to: "Mac mini", files_left: 2 } }, BACKGROUND_CONTEXT);
      await s.chats.open(agent.id, conversationId);
      s.faux.setResponses([s.reply("one"), s.reply("two")]);
      const send = async (text: string, turns: number) => {
        await s.chats.send({ agent_id: agent.id, conversation_id: conversationId, text, images: [], send_id: text, context: null });
        await until(() => kinds(s.pushed).filter((k) => k === "turn_end").length === turns);
      };
      await send("first", 1);
      expect(s.sent[0]).toContain("This chat moved from MacBook to Mac mini");
      expect(s.sent[0]).toContain("2 files attached before the move stayed on MacBook");
      // What was sent is JSON, which escapes a Windows path's backslashes.
      expect(s.sent[0]).toContain(JSON.stringify(`This chat's folder, ${join(s.dir, "not-here")}, is not on Mac mini.`).slice(1, -1));
      await send("second", 2);
      expect(s.sent[1].match(/This chat moved/g)).toHaveLength(1);
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
