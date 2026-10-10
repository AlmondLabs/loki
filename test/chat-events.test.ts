import { describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, MemoryStorage, watchEvents, type AgentEvent } from "@earendil-works/pi-durable";
import { ChatEventConverter } from "../daemon/chat-events.ts";
import { AgentStore } from "../daemon/kernel/index.ts";
import { applyChatEvent, chatStatusOf, emptyLive, type ChatEvent } from "../core/attention/model.ts";

const ctx = BACKGROUND_CONTEXT;
const NOW = "2026-10-10T10:00:00.000Z";

describe("chat event converter", () => {
  test("streamed pieces go out as they come, and only the unsent rest when the answer is written", () => {
    const c = new ChatEventConverter();
    const piece = (delta: string) => ({ type: "message_update", usage: {} as never, changes: [{ type: "text_delta", contentIndex: 0, delta }] }) as AgentEvent;
    expect(c.convert(piece("Hel"), NOW)).toEqual([{ kind: "step", step: { kind: "assistant", text: "Hel", at: NOW, chunk: true } }]);
    c.convert(piece("lo"), NOW);
    const end = c.convert({ type: "message_end", entry: { id: 1 as never, conversationId: 1 as never, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "Hello there" }] } as never] } }, NOW);
    expect(end).toEqual([{ kind: "step", step: { kind: "assistant", text: " there", at: NOW, chunk: true } }]);
  });

  test("an answer written whole sends all its words, then its tool calls", () => {
    const c = new ChatEventConverter();
    const end = c.convert({ type: "message_end", entry: { id: 1 as never, conversationId: 1 as never, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "Let me look." }, { type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } }] } as never] } }, NOW);
    expect(end).toEqual([
      { kind: "step", step: { kind: "assistant", text: "Let me look.", at: NOW, chunk: true } },
      { kind: "step", step: { kind: "call", name: "read", args: { path: "a" }, id: "t1", at: NOW } },
    ]);
  });

  test("a message the agent could not take up (no model) ends the turn with why, and the live state settles", async () => {
    const models = createModels();
    const store = await AgentStore.open({ storage: new MemoryStorage() }, { models, registry: createRegistry() }, ctx);
    try {
      const chat = await store.createChat("c", { agent: { model: { provider: "nowhere", modelId: "nothing" } } }, ctx);
      const stream = await watchEvents(store.harness, chat.id, ctx);
      const c = new ChatEventConverter();
      const events: ChatEvent[] = [];
      stream.start(async (batch) => void events.push(...batch.flatMap((ev) => c.convert(ev, NOW))));
      await (await chat.submit({ type: "input", content: "hello" }, ctx)).wait(ctx);
      const end = Date.now() + 2000;
      while (!events.some((e) => e.kind === "turn_end") && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
      expect(events.find((e) => e.kind === "error")).toEqual({ kind: "error", message: expect.stringContaining("model is not available") });
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
    expect(new ChatEventConverter().convert({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash" }, NOW)).toEqual([{ kind: "step", step: { kind: "result", id: "t1", output: "the tool did not finish", failed: true } }]);
  });

  test("a real run, folded into a chat's live state, reads as the thread the app shows", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    registry.install(defineExtension({ name: "t", tools: [defineTool({ name: "echo", description: "echo", parameters: { type: "object", properties: {} } as never, execute: async () => ({ content: [{ type: "text", text: "echoed" }] }) })] }));
    const store = await AgentStore.open({ storage: new MemoryStorage() }, { models, registry }, ctx);
    try {
      const chat = await store.createChat("c", { agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } } }, ctx);
      const stream = await watchEvents(store.harness, chat.id, ctx);
      const converter = new ChatEventConverter();
      const events: ChatEvent[] = [];
      stream.start(async (batch) => {
        for (const ev of batch) events.push(...converter.convert(ev, NOW));
      });
      faux.setResponses([fauxAssistantMessage(fauxToolCall("echo", {}), { stopReason: "toolUse" }), fauxAssistantMessage("All done.")]);
      await (await chat.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
      await new Promise((r) => setTimeout(r, 50));
      await stream.stop();
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
