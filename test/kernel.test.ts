import { describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { AgentStore } from "../daemon/kernel/index.ts";
import { entrySteps } from "../core/attention/pi-steps.ts";
import { foldSteps } from "../core/attention/thread.ts";

const ctx = BACKGROUND_CONTEXT;

/** A store on memory with a faux model that records what each request sent. */
async function fauxStore() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const sent: unknown[][] = [];
  const reply = (text: string) => (context: { messages: unknown[] }) => {
    sent.push(context.messages);
    return fauxAssistantMessage(text);
  };
  const model = { provider: faux.provider.id, modelId: faux.getModel().id };
  const store = await AgentStore.open({ storage: new MemoryStorage() }, { models, registry: createRegistry() }, ctx);
  return { store, faux, sent, reply, model };
}

describe("agent store", () => {
  test("a chat is found again by loki's id, and listed with its info", async () => {
    const { store, model } = await fauxStore();
    try {
      await store.createChat("local-conv-1", { title: "Plans", agent: { model }, createdAt: "2026-10-01T00:00:00.000Z" }, ctx);
      await store.createChat("default", { agent: { model } }, ctx);
      expect(await store.chat("local-conv-1", ctx)).toBeDefined();
      expect(await store.chat("missing", ctx)).toBeUndefined();
      const listed = await store.chats(ctx);
      expect(listed.map((c) => c.id).sort()).toEqual(["default", "local-conv-1"]);
      expect(listed.find((c) => c.id === "local-conv-1")).toMatchObject({ title: "Plans", archived: false, createdAt: "2026-10-01T00:00:00.000Z" });
      await expect(store.createChat("local-conv-1", {}, ctx)).rejects.toThrow("already exists");
    } finally {
      await store.close(ctx);
    }
  });

  test("the same request id sent twice makes one message", async () => {
    const { store, faux, reply, model } = await fauxStore();
    try {
      const chat = await store.createChat("c", { agent: { model } }, ctx);
      faux.setResponses([reply("hi")]);
      const first = await chat.submit({ type: "input", content: "hello", requestId: "same" }, ctx);
      const again = await chat.submit({ type: "input", content: "hello", requestId: "same" }, ctx);
      expect(again.id).toBe(first.id);
      await first.wait(ctx);
      const users = (await store.entries(chat, ctx)).filter((e) => e.kind === "pi.user");
      expect(users).toHaveLength(1);
    } finally {
      await store.close(ctx);
    }
  });

  test("two agents' stores run chats at the same time without crossing", async () => {
    const a = await fauxStore();
    const b = await fauxStore();
    try {
      const chatA = await a.store.createChat("x", { agent: { model: a.model } }, ctx);
      const chatB = await b.store.createChat("x", { agent: { model: b.model } }, ctx);
      a.faux.setResponses([a.reply("answer A")]);
      b.faux.setResponses([b.reply("answer B")]);
      const [sa, sb] = await Promise.all([
        chatA.submit({ type: "input", content: "question A" }, ctx),
        chatB.submit({ type: "input", content: "question B" }, ctx),
      ]);
      await Promise.all([sa.wait(ctx), sb.wait(ctx)]);
      const rowsA = foldSteps((await a.store.entries(chatA, ctx)).flatMap(entrySteps)).map((r) => r.text);
      const rowsB = foldSteps((await b.store.entries(chatB, ctx)).flatMap(entrySteps)).map((r) => r.text);
      expect(rowsA).toEqual(["question A", "answer A"]);
      expect(rowsB).toEqual(["question B", "answer B"]);
    } finally {
      await a.store.close(ctx);
      await b.store.close(ctx);
    }
  });
});
