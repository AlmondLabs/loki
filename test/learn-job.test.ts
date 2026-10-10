import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { AgentStore } from "../daemon/kernel/index.ts";
import { StoreManager } from "../daemon/kernel/stores.ts";
import { ChatProjection } from "../daemon/chats.ts";
import { learnJob } from "../daemon/learn.ts";
import { PassRunner } from "../daemon/passes.ts";
import { PassState } from "../daemon/passes-state.ts";
import { createAgent } from "../daemon/store/agents.ts";
import { RecallStore, isoDay } from "../mod/recall.ts";

const ctx = BACKGROUND_CONTEXT;
const LONG = "you explained how a river delta builds land: sediment drops where the current slows at the mouth, layer on layer. ".repeat(4);
const card = (front: string, back = "an answer") => ({ front, back, tags: ["geo"] });
const json = (v: unknown) => fauxAssistantMessage(JSON.stringify(v));

async function setup(opts: { cap?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "loki-learn-"));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const agentId = await createAgent(dir, { name: "Ada", model: `${faux.provider.id}/${faux.getModel().id}` });
  const registry = createRegistry();
  const stores = new StoreManager(join(dir, "stores"), { models, registry }, ctx, () => {}, () => AgentStore.open({ storage: new MemoryStorage() }, { models, registry }, ctx));
  const chats = new ChatProjection(ctx, () => "Ada");
  chats.follow(stores);
  const state = new PassState(join(dir, "state"));
  state.setSettings({ reflection: { enabled: false }, learn: { enabled: true, dailyCap: opts.cap ?? 5 } });
  const recall = new RecallStore(join(dir, "recall"));
  // A minute ahead of the messages, so every chat counts as quiet.
  let now = new Date(Date.now() + 60_000);
  const reports: string[] = [];
  const prompts: string[] = [];
  const runner = new PassRunner({ stores, chats, registry, state, backendDir: dir, context: ctx, jobs: [learnJob({ store: recall, state, chats })], busy: async () => false, isSubagent: () => false, report: (m) => reports.push(m), now: () => now, quietMs: 0 });
  const store = await stores.get(agentId);
  await store.setAgent({ id: agentId, name: "Ada" }, ctx);
  const model = { provider: faux.provider.id, modelId: faux.getModel().id };
  const say = async (chatId: string, text: string) => {
    const chat = (await store.chat(chatId, ctx)) ?? (await store.createChat(chatId, { title: `chat ${chatId}`, agent: { model } }, ctx));
    await (await chat.submit({ type: "input", content: text }, ctx)).wait(ctx);
  };
  // The person's chats get "ok"; Learn's ask gets the next scripted answer, and the prompt is kept.
  const answers: Array<ReturnType<typeof json>> = [];
  faux.setResponses(Array.from({ length: 40 }, () => (c: { messages: unknown }) => {
    const text = JSON.stringify(c.messages);
    if (!text.includes("spaced-repetition cards")) return fauxAssistantMessage("ok");
    prompts.push(text);
    return answers.shift() ?? json({ cards: [], revisions: [] });
  }));
  const cleanup = async () => {
    await stores.closeAll();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, agentId, chats, state, recall, runner, reports, prompts, answers, say, cleanup, setNow: (d: Date) => (now = d), entries: (c: string) => chats.answers(c, agentId, 0).entries };
}

describe("Learn on the background passes", () => {
  test("a settled chat gives cards with their source, counted against the day, and its cursor moves on", async () => {
    const s = await setup();
    try {
      await s.say("c1", LONG);
      s.answers.push(json({ cards: [card("How does a river delta build land?")], revisions: [], leads: [{ title: "Sediment transport", why: "you asked how", depth: "primer" }] }));
      await s.runner.sweep();
      expect(s.recall.cards().map((c) => c.card.front)).toEqual(["How does a river delta build land?"]);
      expect(s.recall.cards()[0].card.source).toMatchObject({ agentId: s.agentId, conversationId: "c1", title: "chat c1" });
      expect(s.recall.leads().map((l) => l.title)).toEqual(["Sediment transport"]);
      expect(s.state.writtenOn(isoDay(Date.now() + 60_000))).toBe(1);
      expect(s.state.cursor("learn", s.agentId, "c1")).toBe(s.entries("c1"));
      expect(s.state.learnLast()?.note).toContain("1 new");
    } finally {
      await s.cleanup();
    }
  });

  test("a stretch of task detail writes no card, and the cursor moves past it", async () => {
    const s = await setup();
    try {
      await s.say("c1", LONG);
      s.answers.push(json({ cards: [], revisions: [] }));
      await s.runner.sweep();
      expect(s.recall.cards()).toEqual([]);
      expect(s.state.cursor("learn", s.agentId, "c1")).toBe(s.entries("c1"));
      expect(s.state.learnLast()?.note).toBe("nothing worth a card");
    } finally {
      await s.cleanup();
    }
  });

  test("with the day's cards written, a settled chat waits, and is read the next day from the same place", async () => {
    const s = await setup({ cap: 1 });
    try {
      await s.say("c1", LONG);
      s.answers.push(json({ cards: [card("How does a river delta build land?"), card("Where does sediment drop?")], revisions: [] }));
      await s.runner.sweep();
      // One fit; the other waits, so the stretch is read again tomorrow.
      expect(s.recall.cards()).toHaveLength(1);
      expect(s.state.cursor("learn", s.agentId, "c1")).toBeUndefined();
      await s.say("c2", LONG);
      await s.runner.sweep();
      expect(s.prompts).toHaveLength(1);
      const tomorrow = new Date(Date.now() + 86_400_000);
      s.setNow(tomorrow);
      s.answers.push(json({ cards: [card("How does a river delta build land?"), card("Where does sediment drop?")], revisions: [] }));
      await s.runner.sweep();
      // The first card is not written twice; the second lands today.
      expect(s.recall.cards().map((c) => c.card.front)).toEqual(["How does a river delta build land?", "Where does sediment drop?"]);
      expect(s.state.writtenOn(isoDay(tomorrow.getTime()))).toBe(1);
    } finally {
      await s.cleanup();
    }
  });

  test("a card like a deleted one is not written, and the deleted one is quoted to the model", async () => {
    const s = await setup();
    try {
      s.recall.add({ id: "k1", ...card("What is a delta?"), source: { agentId: s.agentId, agentName: "Ada", conversationId: "old", title: null, at: null }, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", updatedBy: "recall", previous: [] });
      s.recall.reject("k1");
      await s.say("c1", LONG);
      s.answers.push(json({ cards: [card("What is a delta?")], revisions: [] }));
      await s.runner.sweep();
      expect(s.recall.cards()).toEqual([]);
      expect(s.prompts[0]).toContain("What is a delta?");
    } finally {
      await s.cleanup();
    }
  });

  test("a card the person keeps failing rides along from its own chat and comes back revised, its old wording kept", async () => {
    const s = await setup();
    try {
      await s.say("old", LONG);
      s.state.setCursor("learn", s.agentId, "old", s.entries("old"));
      s.recall.add({ id: "k1", front: "Why does a delta grow?", back: "rivers", tags: [], source: { agentId: s.agentId, agentName: "Ada", conversationId: "old", title: "old", at: null }, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", updatedBy: "recall", previous: [] });
      // Missed again and again since it was last written.
      for (const day of [2, 3, 4, 5]) s.recall.grade("k1", 1, new Date(`2026-10-0${day}T00:00:00Z`).getTime());
      await s.say("c1", LONG);
      s.answers.push(json({ cards: [], revisions: [{ id: "k1", slice: "s2", back: "sediment drops where the current slows", reason: "sharper" }] }));
      await s.runner.sweep();
      expect(s.prompts[0]).toContain('mode=\\"replay\\" for=\\"k1\\"');
      const revised = s.recall.card("k1")!.card;
      expect(revised.back).toBe("sediment drops where the current slows");
      expect(revised.previous.at(-1)).toMatchObject({ back: "rivers" });
    } finally {
      await s.cleanup();
    }
  });

  test("leads like a dismissed one are dropped, and none are named once the open pile is full", async () => {
    const s = await setup();
    try {
      const lead = (id: string, title: string) => ({ id, title, why: "w", depth: "primer" as const, source: { agentId: s.agentId, agentName: "Ada", conversationId: "x", title: null, at: null }, createdAt: "2026-10-01T00:00:00Z" });
      s.recall.addLead(lead("d1", "Sediment transport"));
      s.recall.dismissLead("d1");
      await s.say("c1", LONG);
      s.answers.push(json({ cards: [], revisions: [], leads: [{ title: "Sediment transport", why: "again", depth: "primer" }, { title: "Tidal deltas", why: "you asked", depth: "course" }] }));
      await s.runner.sweep();
      expect(s.recall.leads().map((l) => l.title)).toEqual(["Tidal deltas"]);
      for (let i = 0; i < 11; i++) s.recall.addLead(lead(`o${i}`, `Open lead number ${i} about something distinct ${i}`));
      await s.say("c2", LONG);
      s.answers.push(json({ cards: [], revisions: [], leads: [{ title: "Alluvial fans", why: "w", depth: "primer" }] }));
      await s.runner.sweep();
      expect(s.recall.leads().some((l) => l.title === "Alluvial fans")).toBe(false);
    } finally {
      await s.cleanup();
    }
  });

  test("an answer that is not the JSON asked for writes nothing", async () => {
    const s = await setup();
    try {
      await s.say("c1", LONG);
      s.answers.push(fauxAssistantMessage("I could not decide."));
      await s.runner.sweep();
      expect(s.recall.cards()).toEqual([]);
      expect(s.state.cursor("learn", s.agentId, "c1")).toBe(s.entries("c1"));
    } finally {
      await s.cleanup();
    }
  });
});
