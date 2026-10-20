import { describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { AgentStore } from "../daemon/kernel/index.ts";
import { ChatProjection } from "../daemon/chats.ts";
import { lettaLogEntries } from "../daemon/import/convert.ts";
import { entrySteps } from "../core/attention/pi-steps.ts";
import { foldSteps } from "../core/attention/thread.ts";
import { conversationDirName } from "../core/desk-core.ts";
import { sampleLog } from "./fixtures/letta-log.ts";

const ctx = BACKGROUND_CONTEXT;
const AGENT = "agent-local-a";

async function setup() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const store = await AgentStore.open({ storage: new MemoryStorage() }, { models, registry: createRegistry() }, ctx);
  const model = { provider: faux.provider.id, modelId: faux.getModel().id };
  const chats = new ChatProjection(ctx, (id) => (id === AGENT ? "Ada" : null));
  return { store, faux, model, chats };
}

describe("chat projection", () => {
  test("an imported chat reads as the same rows, with its details, once its store is attached", async () => {
    const { store, model, chats } = await setup();
    try {
      const chat = await store.createChat("local-conv-1", { title: "Readme", agent: { model, cwd: "/work/loki" } }, ctx);
      const converted = lettaLogEntries(sampleLog());
      await store.importEntries(chat, converted, ctx);
      await chats.attach(AGENT, store);
      expect(chats.page("local-conv-1", AGENT, 1000)).toEqual({ rows: foldSteps(converted.flatMap((e) => entrySteps(e))), more: false });
      expect(chats.page("local-conv-1", AGENT, 2).more).toBe(true);
      expect(chats.info("local-conv-1", AGENT)).toMatchObject({
        agentId: AGENT,
        title: "Readme",
        archived: false,
        model: `${model.provider}/${model.modelId}`,
        // No thinking level set is pi's default, off.
        reasoningEffort: "none",
        lastMessageAt: "2026-10-01T10:00:06.000Z",
      });
      expect(chats.list()).toEqual([
        { conversationId: "local-conv-1", agentId: AGENT, archived: false, hidden: false, lastMessageAt: "2026-10-01T10:00:06.000Z" },
      ]);
      expect(chats.agentOf("local-conv-1")).toBe(AGENT);
      expect(chats.folders()).toEqual({
        by_agent: { [AGENT]: ["/work/loki"] },
        by_conversation: { [conversationDirName("local-conv-1", AGENT)]: "/work/loki" },
      });
    } finally {
      await store.close(ctx);
    }
  });

  test("a turn after attaching shows up at once, and Learn's cursor reads only what came after it", async () => {
    const { store, faux, model, chats } = await setup();
    try {
      const chat = await store.createChat("c", { agent: { model } }, ctx);
      await chats.attach(AGENT, store);
      faux.setResponses([fauxAssistantMessage("first answer")]);
      await (await chat.submit({ type: "input", content: "first question" }, ctx)).wait(ctx);
      const cursor = chats.since("c", AGENT, 0);
      expect(cursor.rows.map((r) => r.text)).toEqual(["first question", "first answer"]);
      faux.setResponses([fauxAssistantMessage("second answer")]);
      await (await chat.submit({ type: "input", content: "second question" }, ctx)).wait(ctx);
      const next = chats.since("c", AGENT, cursor.lines);
      expect(next.rows.map((r) => r.text)).toEqual(["second question", "second answer"]);
      expect(chats.digest("c", AGENT)).toEqual({ last_role: "assistant", last_assistant_text: "second answer", last_ask: "person" });
    } finally {
      await store.close(ctx);
    }
  });

  test("a chat created, renamed or archived after attaching is seen without asking the store", async () => {
    const { store, model, chats } = await setup();
    try {
      await chats.attach(AGENT, store);
      await store.createChat("later", { agent: { model } }, ctx);
      expect(chats.list().map((c) => c.conversationId)).toEqual(["later"]);
      await store.updateChat("later", { title: "Plans", archived: true }, ctx);
      expect(chats.info("later", AGENT)).toMatchObject({ title: "Plans", archived: true });
      expect(chats.list()[0]).toMatchObject({ archived: true });
    } finally {
      await store.close(ctx);
    }
  });

  test("an agent's main chat is called by the agent's name, and is found only with its agent", async () => {
    const { store, model, chats } = await setup();
    try {
      await store.createChat("default", { agent: { model } }, ctx);
      await chats.attach(AGENT, store);
      expect(chats.info("default", AGENT)?.title).toBe("Ada · main chat");
      expect(chats.info("default")).toBeNull();
      expect(chats.agentOf("default")).toBeNull();
    } finally {
      await store.close(ctx);
    }
  });

  test("a scheduled prompt is the schedule's ask, not the person's", async () => {
    const { store, faux, model, chats } = await setup();
    try {
      const chat = await store.createChat("s", { agent: { model } }, ctx);
      await chats.attach(AGENT, store);
      faux.setResponses([fauxAssistantMessage("report")]);
      await (await chat.submit({ type: "input", content: "Scheduled task: morning report" }, ctx)).wait(ctx);
      expect(chats.digest("s", AGENT).last_ask).toBe("schedule");
    } finally {
      await store.close(ctx);
    }
  });

  test("an ACP chat reads as its agent's model and the effort chosen for it, when loki has a word for that effort", async () => {
    const { store, model, chats } = await setup();
    try {
      await store.createChat("acp", { agent: { model } }, ctx);
      await chats.attach(AGENT, store);
      const engine = { kind: "acp" as const, agent: "claude-code", model: "sonnet", session_id: null };
      await store.updateChat("acp", { engine: { ...engine, effort: "high" } }, ctx);
      expect(chats.info("acp", AGENT)).toMatchObject({ model: "acp:claude-code/sonnet", reasoningEffort: "high" });
      await store.updateChat("acp", { engine: { ...engine, effort: "ultra" } }, ctx);
      expect(chats.info("acp", AGENT)?.reasoningEffort).toBeNull();
      await store.updateChat("acp", { engine }, ctx);
      expect(chats.info("acp", AGENT)?.reasoningEffort).toBeNull();
    } finally {
      await store.close(ctx);
    }
  });

  test("an unknown chat reads as nothing", async () => {
    const { chats } = await setup();
    expect(chats.info("nope", AGENT)).toBeNull();
    expect(chats.page("nope", AGENT, 10)).toEqual({ rows: [], more: false });
    expect(chats.since("nope", AGENT, 0)).toEqual({ rows: [], lines: 0 });
    expect(chats.digest("nope", AGENT)).toEqual({ last_role: null, last_assistant_text: null, last_ask: null });
  });
});
