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
    // Through JSON, not structuredClone, as the move travels between Macs: what the wire drops is dropped here too.
    // react-doctor-disable-next-line react-doctor/no-json-parse-stringify-clone
    expect(await importChat(s.mini, JSON.parse(JSON.stringify(moved)) as typeof moved, ctx)).toBe(true);
    expect(await said(s.mini, "conv-1")).toEqual(await said(s.book, "conv-1"));
    const info = must(await s.mini.chatInfo(must(await s.mini.chat("conv-1", ctx), "chat").id, ctx), "info");
    expect(info).toMatchObject({ title: "plan the week", labels: ["health"], mode: "plan" });
    const settings = (await s.mini.agentSettings(must(await s.mini.chat("conv-1", ctx), "chat").id, ctx)) as { cwd?: string };
    expect(settings.cwd).toBe("/Users/me/home");
    expect(moved.cursors).toEqual({ reflection: 3 });
  });

  test("keeps its purpose line, its saved draft and its suggestions (plan 049, U1)", async () => {
    const s = await stores();
    await s.book.createChat("conv-1", { agent: { model: s.model } }, ctx);
    const draft = { text: "check the deploy", suggestion_id: "sug-2", source: { agent_id: "agent-ira", conversation_id: "conv-9" } };
    const suggestions = [
      {
        id: "sug-1",
        title: "fix upload",
        text: "the upload test is flaky",
        target: { agent_id: "agent-ira", conversation_id: "conv-5" },
        status: "rejected" as const,
        decided_by: "desktop",
        decided_at: "2026-10-29T11:00:00.000Z",
        created_at: "2026-10-29T10:00:00.000Z",
      },
    ];
    await s.book.updateChat("conv-1", { purpose: "the website", draft, suggestions }, ctx);
    const moved = must(await exportChat(s.book, "agent-ira", "conv-1", { schedules: [], cursors: {} }, ctx), "the export");
    // Through JSON, not structuredClone, as the move travels between Macs: what the wire drops is dropped here too.
    // react-doctor-disable-next-line react-doctor/no-json-parse-stringify-clone
    expect(await importChat(s.mini, JSON.parse(JSON.stringify(moved)) as typeof moved, ctx)).toBe(true);
    const info = must(await s.mini.chatInfo(must(await s.mini.chat("conv-1", ctx), "chat").id, ctx), "info");
    expect(info).toMatchObject({ purpose: "the website", draft, suggestions });
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

describe("a chat moved there and back", () => {
  test("comes back whole over the copy it left, keeps its placed mark, and the set-aside copy stays hidden", async () => {
    const s = await stores();
    s.faux.setResponses([fauxAssistantMessage("hello"), fauxAssistantMessage("on the mini"), fauxAssistantMessage("back")]);
    const chat = await s.book.createChat("conv-1", { agent: { model: s.model } }, ctx);
    await (await chat.submit({ type: "input", content: "hi" }, ctx)).wait(ctx);
    // There: placed on purpose, and the MacBook lets go of its copy.
    const there = must(await exportChat(s.book, "agent-friday", "conv-1", { schedules: [], cursors: {} }, ctx), "the export");
    expect(await importChat(s.mini, { ...there, info: { ...there.info, placed: true } }, ctx)).toBe(true);
    await s.book.updateChat("conv-1", { hidden: true }, ctx);
    const onMini = must(await s.mini.chat("conv-1", ctx), "on the mini");
    await (await onMini.submit({ type: "input", content: "more" }, ctx)).wait(ctx);
    // And back.
    const back = must(await exportChat(s.mini, "agent-friday", "conv-1", { schedules: [], cursors: {} }, ctx), "the export back");
    expect(back.info.placed).toBe(true);
    expect(await importChat(s.book, back, ctx)).toBe(true);
    expect(await said(s.book, "conv-1")).toEqual(await said(s.mini, "conv-1"));
    const info = must(await s.book.chatInfo(must(await s.book.chat("conv-1", ctx), "chat").id, ctx), "info");
    expect(info).toMatchObject({ hidden: false, placed: true });
    const all = await s.book.chats(ctx);
    expect(all.filter((c) => c.id.startsWith("conv-1~moved-")).map((c) => c.hidden)).toEqual([true]);
    // A chat still here and in use is never written over.
    expect(await importChat(s.book, back, ctx)).toBe(false);
  });
});

describe("a moved chat's mark", () => {
  test("the thread keeps one quiet mark where it moved, and the agent's note counts the files that stayed behind", async () => {
    const s = await stores();
    s.faux.setResponses([fauxAssistantMessage("got it")]);
    const chat = await s.book.createChat("conv-1", { agent: { model: s.model } }, ctx);
    const gone = join(tmpdir(), "loki-not-there", "plan.pdf");
    await (
      await chat.submit({ type: "input", content: `read this <attachment kind="file" local_path="${gone}" name="plan.pdf" mime_type="application/pdf"/>` }, ctx)
    ).wait(ctx);
    const moved = must(await exportChat(s.book, "agent-ira", "conv-1", { schedules: [], cursors: {} }, ctx), "the export");
    expect(await importChat(s.mini, moved, ctx, { from: "MacBook", to: "Mac mini" }, Date.parse("2026-10-19T09:00:00Z"))).toBe(true);
    const there = must(await s.mini.chat("conv-1", ctx), "chat");
    const entries = await s.mini.entries(there, ctx);
    expect(entries.at(-1)).toMatchObject({ kind: "loki.branch" });
    expect(JSON.stringify(entries.at(-1)?.data)).toContain('<loki-moved from=\\"MacBook\\" to=\\"Mac mini\\"/>');
    expect((await s.mini.chatInfo(there.id, ctx))?.moved).toEqual({ from: "MacBook", to: "Mac mini", files_left: 1 });
  });
});

describe("a moved chat's schedules", () => {
  test("keep their id and when they last fired, so a slot fired on the old Mac does not fire again here", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-adopt-"));
    try {
      const book = new Schedules(join(dir, "book.json"), () => Promise.resolve(null));
      const mini = new Schedules(join(dir, "mini.json"), () => Promise.resolve(null));
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

  test("come back with their chat: the copy cancelled when it moved away is replaced", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-adopt-"));
    try {
      const book = new Schedules(join(dir, "book.json"), () => Promise.resolve(null));
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
      book.cancel("agent-ira", task.id);
      const back = { ...task, last_fired_at: "2026-10-18T09:00:00.000Z", fire_count: 3 };
      book.adopt(back);
      expect(book.list()).toEqual([back]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
