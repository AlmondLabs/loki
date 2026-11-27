import { describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineExtension,
  defineTool,
  MemoryStorage,
  type ConversationView,
  type EntryRecord,
  type LiveState,
} from "@earendil-works/pi-durable";
import { ChatEventConverter } from "../daemon/chat-events.ts";
import { AgentStore } from "../daemon/kernel/index.ts";
import { applyChatEvent, chatStatusOf, emptyLive, type ChatEvent } from "../core/attention/model.ts";
import { must } from "./fixtures/must.ts";

const ctx = BACKGROUND_CONTEXT;
const NOW = "2026-10-10T10:00:00.000Z";
const run = { taskId: 1 as never, inputs: [], turns: 0 };

const view = (opts: { entries?: EntryRecord[]; live?: LiveState } = {}): ConversationView => ({
  conversation: { id: 1 } as never,
  entries: opts.entries ?? [],
  docs: opts.live ? { "pi.live": opts.live } : {},
});

const assistantEntry = (content: Array<{ type: string; [k: string]: unknown }>, id = 1): EntryRecord =>
  ({
    id,
    conversationId: 1,
    kind: "pi.assistant",
    model: [{ role: "assistant", content }],
  }) as unknown as EntryRecord;

const piece = (text: string) => view({ live: { run, generation: { attempt: 0, message: { role: "assistant", content: [{ type: "text", text }] } as never } } });

const contentView = (content: Array<{ type: string; [k: string]: unknown }>) =>
  view({ live: { run, generation: { attempt: 0, message: { role: "assistant", content } as never } } });

const written = (text: string, id = 1, active = true) =>
  view({
    entries: [assistantEntry([{ type: "text", text }], id)],
    ...(active ? { live: { run } } : {}),
  });

describe("chat event converter", () => {
  test("streamed pieces go out as they come, and the answer goes out whole when written, as history has it", () => {
    const c = new ChatEventConverter();
    expect(c.convert(piece("Hel"), NOW)).toEqual([
      { kind: "loop", state: "running" },
      { kind: "step", step: { kind: "assistant", text: "Hel", at: NOW, chunk: true } },
    ]);
    expect(c.convert(piece("Hello"), NOW)).toEqual([{ kind: "step", step: { kind: "assistant", text: "lo", at: NOW, chunk: true } }]);
    expect(c.convert(written("Hello there", 1, true), NOW)).toEqual([{ kind: "step", step: { kind: "assistant", text: "Hello there", at: NOW } }]);
  });

  test("an answer written whole sends all its words, then its tool calls", () => {
    const c = new ChatEventConverter();
    const end = c.convert(
      view({
        entries: [
          assistantEntry([
            { type: "text", text: "Let me look." },
            { type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } },
          ]),
        ],
        live: { run },
      }),
      NOW,
    );
    expect(end).toEqual([
      { kind: "loop", state: "running" },
      { kind: "step", step: { kind: "assistant", text: "Let me look.", at: NOW } },
      { kind: "step", step: { kind: "call", name: "read", args: { path: "a" }, id: "t1", at: NOW } },
    ]);
  });

  test("the answer in flight is known for a client that opens mid-answer, and forgotten when it is written or dropped", () => {
    const c = new ChatEventConverter();
    expect(c.inFlight()).toBeNull();
    c.convert(piece("Keep `fa"), NOW);
    c.convert(piece("Keep `farmart"), "2026-10-10T10:00:01.000Z");
    expect(c.inFlight()).toEqual({ text: "Keep `farmart", at: NOW });
    c.convert(view({ live: { run, generation: { attempt: 1, retry: { at: 0, error: "overloaded" } } } }), NOW);
    expect(c.inFlight()).toBeNull();
    c.convert(piece("Keep"), NOW);
    c.convert(written("Keep it", 1, false), NOW);
    expect(c.inFlight()).toBeNull();
    const late = new ChatEventConverter();
    late.seed(
      contentView([
        { type: "thinking", thinking: "hm" },
        { type: "text", text: "Keep `far" },
      ]),
      NOW,
    );
    expect(late.inFlight()).toEqual({ text: "Keep `far", at: NOW });
    late.convert(
      contentView([
        { type: "thinking", thinking: "hm" },
        { type: "text", text: "Keep `farmart" },
      ]),
      NOW,
    );
    expect(late.inFlight()?.text).toBe("Keep `farmart");
    late.convert(view(), NOW);
    expect(late.inFlight()).toBeNull();
  });

  describe("an answer's words in every shape a batch brings them", () => {
    const fold = (views: ConversationView[]) => {
      const c = new ChatEventConverter();
      const l = emptyLive();
      for (const v of views) for (const out of c.convert(v, NOW)) applyChatEvent(l, out, NOW);
      return { shown: l.thread.rows()?.map((r) => r.text) ?? [], inFlight: c.inFlight()?.text ?? null };
    };

    test("a text block begun with its first words already in it, then words added", () => {
      const views = [piece("Yes. Skills give townhall a way"), piece("Yes. Skills give townhall a way to preserve how")];
      expect(fold(views)).toEqual({ shown: ["Yes. Skills give townhall a way to preserve how"], inFlight: "Yes. Skills give townhall a way to preserve how" });
    });

    test("a message begun with its first words already in it, then words added", () => {
      const views = [piece("Then "), piece("Then all published skills")];
      expect(fold(views)).toEqual({ shown: ["Then all published skills"], inFlight: "Then all published skills" });
    });

    test("a block after thinking: only the text shows, and a second text block joins as the written answer joins them", () => {
      const views = [
        contentView([
          { type: "thinking", thinking: "hm" },
          { type: "text", text: "One" },
        ]),
        contentView([
          { type: "thinking", thinking: "hm more" },
          { type: "text", text: "One two" },
        ]),
        contentView([
          { type: "thinking", thinking: "hm more" },
          { type: "text", text: "One two" },
          { type: "text", text: "Three" },
        ]),
      ];
      expect(fold(views).shown).toEqual(["One two\nThree"]);
    });

    test("a block or the whole message rewritten: the client is handed the answer so far in place of what it had", () => {
      const rewritten = [piece("Kept it"), piece("Keep it short")];
      expect(fold(rewritten).shown).toEqual(["Keep it short"]);
      const replaced = [piece("Kept it"), piece("Keep"), piece("Keep going")];
      expect(fold(replaced)).toEqual({ shown: ["Keep going"], inFlight: "Keep going" });
    });

    test("a batch that changes no words sends nothing", () => {
      const c = new ChatEventConverter();
      c.convert(piece("Hi"), NOW);
      expect(
        c.convert(
          contentView([
            { type: "text", text: "Hi" },
            { type: "thinking", thinking: "hm" },
          ]),
          NOW,
        ),
      ).toEqual([]);
    });
  });

  test("the app sets its stream from what was written so far, and the pieces after it add on", () => {
    const l = emptyLive();
    applyChatEvent(l, { kind: "step", step: { kind: "assistant", text: "rmart", at: NOW, chunk: true } }, NOW);
    applyChatEvent(l, { kind: "streaming", text: "Keep `farmart", at: NOW }, NOW);
    applyChatEvent(l, { kind: "step", step: { kind: "assistant", text: "-co", at: NOW, chunk: true } }, NOW);
    expect(must(l.thread.rows(), "the thread's rows").map((r) => r.text)).toEqual(["Keep `farmart-co"]);
  });

  describe("a reply shows once, however its stream went", () => {
    const REPLY = "Keep `farmart-co-read-write-user` for the farmart.co website project. That closes the Dev review.\n\nNext is Stage `Cluster0`.";
    const drawn = (views: ConversationView[], from = 0) => {
      const c = new ChatEventConverter();
      const out = views.flatMap((v) => c.convert(v, NOW));
      const l = emptyLive();
      for (const e of out.slice(from)) applyChatEvent(l, e, NOW);
      applyChatEvent(l, { kind: "settle" }, NOW);
      const live = must(l.thread.rows(), "the thread's rows")
        .filter((r) => r.role === "assistant")
        .map((r) => r.text);
      l.thread.load(
        [
          { role: "user", text: "farmart-co-read-write-user is needed" },
          { role: "assistant", text: REPLY },
        ],
        0,
      );
      const after = must(l.thread.rows(), "the thread's rows")
        .filter((r) => r.role === "assistant")
        .map((r) => r.text);
      return { live, after, last: l.lastAssistantText };
    };
    const pieces = (text: string, size = 10) => Array.from({ length: Math.ceil(text.length / size) }, (_, i) => piece(text.slice(0, (i + 1) * size)));

    test("streamed cleanly", () => {
      expect(drawn([...pieces(REPLY), written(REPLY, 1, false)])).toEqual({ live: [REPLY], after: [REPLY], last: REPLY });
    });

    test("an attempt that failed part way and was tried again: its pieces are dropped", () => {
      const retry = view({ live: { run, generation: { attempt: 1, retry: { at: 0, error: "overloaded" } } } });
      expect(drawn([...pieces(REPLY).slice(0, 3), retry, ...pieces(REPLY), written(REPLY, 1, false)])).toEqual({
        live: [REPLY],
        after: [REPLY],
        last: REPLY,
      });
    });

    test("a client that joined after the first piece (an Inbox card opened mid-answer)", () => {
      expect(drawn([...pieces(REPLY), written(REPLY, 1, false)], 2)).toEqual({ live: [REPLY], after: [REPLY], last: REPLY });
    });

    test("a stream that is not the start of what was written", () => {
      expect(drawn([...pieces(REPLY.replace("Keep", "Kept")), written(REPLY, 1, false)])).toEqual({ live: [REPLY], after: [REPLY], last: REPLY });
    });
  });

  test("a message the agent could not take up (no model) ends the turn with why, and the live state settles", async () => {
    const models = createModels();
    const store = await AgentStore.open({ storage: new MemoryStorage() }, { models, registry: createRegistry() }, ctx);
    try {
      const chat = await store.createChat("c", { agent: { model: { provider: "nowhere", modelId: "nothing" } } }, ctx);
      const watch = await chat.watch(ctx);
      const c = new ChatEventConverter();
      c.seed(watch.value, NOW);
      const events: ChatEvent[] = [];
      watch.start((call) => {
        if (call.kind === "value") events.push(...c.convert(call.value, NOW));
        return Promise.resolve();
      });
      await (await chat.submit({ type: "input", content: "hello" }, ctx)).wait(ctx);
      const end = Date.now() + 2000;
      while (!events.some((e) => e.kind === "turn_end") && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
      await watch.stop();
      expect(events.find((e) => e.kind === "error")).toEqual({ kind: "error", message: expect.stringContaining("model is not available") as unknown });
      const l = emptyLive();
      for (const e of events) applyChatEvent(l, e, NOW);
      expect(l.inTurn).toBe(false);
      expect(l.error).toContain("model is not available");
    } finally {
      await store.close(ctx);
    }
  });

  test("the daemon's own loop states drive the box: running thinks, idle and approval do not", () => {
    const l = emptyLive();
    expect(chatStatusOf(l)).toBe("idle");
    applyChatEvent(l, { kind: "loop", state: "running" }, NOW);
    expect(chatStatusOf(l)).toBe("thinking");
    applyChatEvent(l, { kind: "loop", state: "idle" }, NOW);
    expect(chatStatusOf(l)).toBe("idle");
    applyChatEvent(l, { kind: "loop", state: "approval" }, NOW);
    expect(chatStatusOf(l)).toBe("idle");
  });

  test("a tool with no result entry shows as failed", () => {
    const converter = new ChatEventConverter();
    converter.seed(view({ live: { run } }), NOW);
    expect(converter.convert(view({ live: { run, tools: [{ callId: "t1", name: "bash", status: "done" }] } }), NOW)).toEqual([
      { kind: "step", step: { kind: "result", id: "t1", output: "the tool did not finish", failed: true } },
    ]);
  });

  const ANSWER = "Yes. Skills give townhall a way to preserve how the organisation does things, not just what people discussed.";
  test.each([
    ["after thinking", [fauxThinking("Let me think about skills for a moment here."), fauxText(ANSWER)]],
    ["with no thinking first", [fauxText(ANSWER)]],
  ])("a real streamed answer shows from its first word while it streams, %s", async (_, content) => {
    const faux = fauxProvider({ tokensPerSecond: 40, tokenSize: { min: 3, max: 3 } });
    const models = createModels();
    models.setProvider(faux.provider);
    const store = await AgentStore.open({ storage: new MemoryStorage() }, { models, registry: createRegistry() }, ctx);
    try {
      const chat = await store.createChat("c", { agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } } }, ctx);
      const watch = await chat.watch(ctx);
      const converter = new ChatEventConverter();
      converter.seed(watch.value, NOW);
      const live = emptyLive();
      const seen: string[] = [];
      watch.start((call) => {
        if (call.kind !== "value") return Promise.resolve();
        for (const e of converter.convert(call.value, NOW)) {
          applyChatEvent(live, e, NOW);
          if (live.thread.streaming) seen.push(must(must(live.thread.rows(), "the thread's rows").at(-1), "the streaming row").text);
        }
        return Promise.resolve();
      });
      faux.setResponses([fauxAssistantMessage(content)]);
      await (await chat.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
      await new Promise((r) => setTimeout(r, 50));
      await watch.stop();
      expect(seen.length).toBeGreaterThan(1);
      for (const text of seen) expect(text).toBe(ANSWER.slice(0, text.length));
      expect(seen[0]).toMatch(/^Yes/);
    } finally {
      await store.close(ctx);
    }
  });

  test("a real run, folded into a chat's live state, reads as the thread the app shows", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "t",
        tools: [
          defineTool({
            name: "echo",
            description: "echo",
            parameters: { type: "object", properties: {} } as never,
            execute: () => Promise.resolve({ output: [{ type: "text", text: "echoed" }] }),
          }),
        ],
      }),
    );
    const store = await AgentStore.open({ storage: new MemoryStorage() }, { models, registry }, ctx);
    try {
      const chat = await store.createChat("c", { agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } } }, ctx);
      const watch = await chat.watch(ctx);
      const converter = new ChatEventConverter();
      converter.seed(watch.value, NOW);
      const events: ChatEvent[] = [];
      watch.start((call) => {
        if (call.kind === "value") events.push(...converter.convert(call.value, NOW));
        return Promise.resolve();
      });
      faux.setResponses([fauxAssistantMessage(fauxToolCall("echo", {}), { stopReason: "toolUse" }), fauxAssistantMessage("All done.")]);
      await (await chat.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
      await new Promise((r) => setTimeout(r, 50));
      await watch.stop();
      const live = emptyLive();
      for (const e of events) applyChatEvent(live, e, NOW);
      expect((live.thread.rows() ?? []).map((r) => [r.role, r.text])).toEqual([
        ["user", "go"],
        ["tool", "echo"],
        ["assistant", "All done."],
      ]);
      expect(live.inTurn).toBe(false);
      expect(live.turns).toBe(1);
    } finally {
      await store.close(ctx);
    }
  });
});
