import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { AgentStore } from "../daemon/kernel/index.ts";
import { StoreManager } from "../daemon/kernel/stores.ts";
import { ChatProjection } from "../daemon/chats.ts";
import { memoryExtension, memoryRoot } from "../daemon/memory.ts";
import { Reflection } from "../daemon/reflection.ts";
import { createAgent } from "../daemon/store/agents.ts";
import { readReflectionConversations } from "../mod/reflection.ts";

const ctx = BACKGROUND_CONTEXT;
const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
};

async function setup(trigger: "step-count" | "off") {
  const dir = mkdtempSync(join(tmpdir(), "loki-reflection-"));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const handle = `${faux.provider.id}/${faux.getModel().id}`;
  const agentId = await createAgent(dir, { name: "Ada", model: handle });
  const registry = createRegistry();
  registry.install(memoryExtension(dir));
  const stores = new StoreManager(join(dir, "stores"), { models, registry }, ctx, () => {}, () => AgentStore.open({ storage: new MemoryStorage() }, { models, registry }, ctx));
  const chats = new ChatProjection(ctx, () => "Ada");
  chats.follow(stores);
  const reports: string[] = [];
  const reflection = new Reflection({ stores, chats, registry, backendDir: dir, root: join(dir, "reflection"), settingsFile: join(dir, "reflection.json"), context: ctx, quietMs: 30, report: (m) => reports.push(m) });
  reflection.setSettings({ trigger, stepCount: 2, merge: "auto", mergeInstructions: "" });
  const store = await stores.get(agentId);
  await store.setAgent({ id: agentId, name: "Ada" }, ctx);
  const chat = await store.createChat("c", { agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } } }, ctx);
  const passes: string[] = [];
  const cleanup = async () => {
    await stores.closeAll();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, faux, agentId, chat, chats, reflection, passes, reports, cleanup };
}

describe("reflection", () => {
  test("after enough answers and a quiet spell, a pass reads the chat and commits to memory as Reflection; its counters are where the Agents page looks", async () => {
    const s = await setup("step-count");
    try {
      let sawTranscript = "";
      s.faux.setResponses([
        fauxAssistantMessage("one"),
        fauxAssistantMessage("two"),
        (c) => {
          sawTranscript = JSON.stringify(c.messages);
          return fauxAssistantMessage(fauxToolCall("memory_write", { path: "system/human.md", content: "Prefers tea.\n", message: "Remember the tea" }), { stopReason: "toolUse" });
        },
        fauxAssistantMessage("kept one thing"),
      ]);
      await (await s.chat.submit({ type: "input", content: "I drink tea" }, ctx)).wait(ctx);
      await (await s.chat.submit({ type: "input", content: "always tea" }, ctx)).wait(ctx);
      const root = memoryRoot(s.dir, s.agentId);
      const log = () => execFileSync("git", ["-C", root, "log", "--format=%an|%s"], { encoding: "utf8" }).trim();
      await until(() => log().startsWith("Reflection|"));
      expect(log().split("\n")[0]).toBe("Reflection|Remember the tea");
      expect(readFileSync(join(root, "system", "human.md"), "utf8")).toBe("Prefers tea.\n");
      expect(sawTranscript).toContain("always tea");
      await until(() => readReflectionConversations(s.agentId, () => null, join(s.dir, "reflection"))[0]?.lastSucceededAt != null);
      const [state] = readReflectionConversations(s.agentId, () => null, join(s.dir, "reflection"));
      expect(state).toMatchObject({ conversationId: "c", stepsSince: 0, totalSteps: 2 });
      // The pass's own chat is hidden, so it never shows as a chat.
      expect(s.chats.list().find((c) => c.conversationId === "reflection-c")?.hidden).toBe(true);
      expect(await s.reflection.run(s.agentId, "c")).toBe("nothing new");
    } finally {
      await s.cleanup();
    }
  });

  test("a pass that fails is reported and leaves the daemon running", async () => {
    const s = await setup("step-count");
    try {
      // Two answers and nothing for the pass: the model fails it.
      s.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
      await (await s.chat.submit({ type: "input", content: "a" }, ctx)).wait(ctx);
      await (await s.chat.submit({ type: "input", content: "b" }, ctx)).wait(ctx);
      await until(() => s.reports.some((r) => r.includes("stopped")));
      expect(s.reports.some((r) => r.startsWith("reflection on c failed"))).toBe(true);
    } finally {
      await s.cleanup();
    }
  });

  test("with reflection off, no pass runs, and the counters still count", async () => {
    const s = await setup("off");
    try {
      s.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);
      for (const text of ["a", "b", "c"]) await (await s.chat.submit({ type: "input", content: text }, ctx)).wait(ctx);
      await until(() => (readReflectionConversations(s.agentId, () => null, join(s.dir, "reflection"))[0]?.stepsSince ?? 0) === 3);
      expect(readReflectionConversations(s.agentId, () => null, join(s.dir, "reflection"))[0]).toMatchObject({ stepsSince: 3, lastStartedAt: null });
      expect(s.faux.getPendingResponseCount()).toBe(0);
    } finally {
      await s.cleanup();
    }
  });

  test("settings round-trip, and a missing file reads as the defaults", async () => {
    const s = await setup("off");
    try {
      expect(s.reflection.setSettings({ trigger: "compaction-event", stepCount: 10, merge: "auto", mergeInstructions: "" })).toEqual({ trigger: "compaction-event", stepCount: 10, merge: "auto", mergeInstructions: "" });
      rmSync(join(s.dir, "reflection.json"));
      expect(s.reflection.settings()).toEqual({ trigger: "step-count", stepCount: 25, merge: "auto", mergeInstructions: "" });
    } finally {
      await s.cleanup();
    }
  });
});
