import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { exportChat, importChat } from "../daemon/chat-move.ts";
import { AgentStore } from "../daemon/kernel/index.ts";
import { Schedules } from "../daemon/schedule.ts";
import { must } from "./fixtures/must.ts";

const ctx = BACKGROUND_CONTEXT;

/** Two Macs' stores for one agent, on one faux model. */
async function stores() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const open = () => AgentStore.open({ storage: new MemoryStorage() }, { models, registry }, ctx);
  return { faux, model: { provider: faux.provider.id, modelId: faux.getModel().id }, book: await open(), mini: await open() };
}

/** What a chat's log says, in order: each entry's kind and its text. */
async function said(store: AgentStore, id: string): Promise<string[]> {
  const chat = must(await store.chat(id, ctx), "the chat");
  return (await store.entries(chat, ctx)).map((e) => `${e.kind}:${JSON.stringify(e.model ?? null).slice(0, 80)}`);
}

describe("a chat moving to another Mac", () => {
  test("arrives under the same id with its whole log, title, folder, labels and mode", async () => {
    const s = await stores();
    s.faux.setResponses([fauxAssistantMessage("hello Ira"), fauxAssistantMessage("noted")]);
    const chat = await s.book.createChat("conv-1", { title: "plan the week", agent: { model: s.model, cwd: "/Users/me/home" } }, ctx);
    await (await chat.submit({ type: "input", content: "hi" }, ctx)).wait(ctx);
    await (await chat.submit({ type: "input", content: "remember the gym" }, ctx)).wait(ctx);
    await s.book.updateChat("conv-1", { labels: ["health"], mode: "plan" }, ctx);
    const moved = must(await exportChat(s.book, "agent-ira", "conv-1", { schedules: [], cursors: { reflection: 3 } }, ctx), "the export");
    // Through the wire as JSON, as the peer link carries it.
    expect(await importChat(s.mini, JSON.parse(JSON.stringify(moved)) as typeof moved, ctx)).toBe(true);
    expect(await said(s.mini, "conv-1")).toEqual(await said(s.book, "conv-1"));
    const info = must(await s.mini.chatInfo(must(await s.mini.chat("conv-1", ctx), "chat").id, ctx), "info");
    expect(info).toMatchObject({ title: "plan the week", labels: ["health"], mode: "plan" });
    const settings = (await s.mini.agentSettings(must(await s.mini.chat("conv-1", ctx), "chat").id, ctx)) as { cwd?: string };
    expect(settings.cwd).toBe("/Users/me/home");
    expect(moved.cursors).toEqual({ reflection: 3 });
  });

  test("moved again (a move tried twice) changes nothing, and a chat that is not there exports nothing", async () => {
    const s = await stores();
    s.faux.setResponses([fauxAssistantMessage("hello")]);
    const chat = await s.book.createChat("conv-1", { agent: { model: s.model } }, ctx);
    await (await chat.submit({ type: "input", content: "hi" }, ctx)).wait(ctx);
    const moved = must(await exportChat(s.book, "agent-ira", "conv-1", { schedules: [], cursors: {} }, ctx), "the export");
    expect(await importChat(s.mini, moved, ctx)).toBe(true);
    expect(await importChat(s.mini, moved, ctx)).toBe(false);
    expect(await exportChat(s.book, "agent-ira", "conv-9", { schedules: [], cursors: {} }, ctx)).toBeNull();
  });
});

describe("a moved chat's schedules", () => {
  test("keep their id and when they last fired, so a slot fired on the old Mac does not fire again here", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-adopt-"));
    try {
      const book = new Schedules(join(dir, "book.json"), () => Promise.resolve());
      const mini = new Schedules(join(dir, "mini.json"), () => Promise.resolve());
      const task = book.create({
        agent_id: "agent-ira",
        conversation_id: "conv-1",
        name: "check-in",
        description: null,
        cron: "0 9 * * *",
        timezone: "UTC",
        recurring: true,
        prompt: "how was the gym?",
      });
      const fired = { ...task, last_fired_at: "2026-10-18T09:00:00.000Z", fire_count: 3 };
      mini.adopt(fired);
      mini.adopt(fired);
      expect(mini.list()).toEqual([fired]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
