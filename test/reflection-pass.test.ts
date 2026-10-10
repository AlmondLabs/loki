import { describe, expect, test } from "vitest";
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
import { PassRunner } from "../daemon/passes.ts";
import { PassState } from "../daemon/passes-state.ts";
import { reflectionJob } from "../daemon/reflection.ts";
import { createAgent } from "../daemon/store/agents.ts";

const ctx = BACKGROUND_CONTEXT;
const LONG = "I drink tea every morning, never coffee, and I like it strong with no sugar at all. ".repeat(5);

async function setup(opts: { quietMs?: number; enabled?: boolean } = {}) {
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
  const state = new PassState(join(dir, "state"));
  state.setSettings({ reflection: { enabled: opts.enabled ?? true } });
  const reports: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  const runner = new PassRunner({ stores, chats, registry, state, backendDir: dir, context: ctx, jobs: [reflectionJob], busy: async () => false, isSubagent: () => false, capture: (_e, p) => events.push(p), report: (m) => reports.push(m), quietMs: opts.quietMs ?? 0 });
  const store = await stores.get(agentId);
  await store.setAgent({ id: agentId, name: "Ada" }, ctx);
  const chat = await store.createChat("c", { agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } } }, ctx);
  const say = async (...texts: string[]) => {
    for (const t of texts) await (await chat.submit({ type: "input", content: t }, ctx)).wait(ctx);
  };
  const log = () => execFileSync("git", ["-C", memoryRoot(dir, agentId), "log", "--format=%an|%s"], { encoding: "utf8" }).trim();
  const cleanup = async () => {
    await stores.closeAll();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, faux, agentId, store, chat, chats, state, runner, reports, events, say, log, cleanup };
}

const remember = (seen: { text: string }) =>
  (c: { messages: unknown }) => {
    seen.text = JSON.stringify(c.messages);
    return fauxAssistantMessage(fauxToolCall("memory_write", { path: "system/human.md", content: "Prefers strong tea.\n", message: "Remember the tea" }), { stopReason: "toolUse" });
  };

describe("reflection on the background passes", () => {
  test("a short chat that has gone quiet is reflected on, and what it keeps is committed to memory as Reflection", async () => {
    const s = await setup();
    try {
      const seen = { text: "" };
      s.faux.setResponses([fauxAssistantMessage("noted"), remember(seen), fauxAssistantMessage("kept one thing")]);
      await s.say(LONG);
      await s.runner.sweep();
      expect(s.log().split("\n")[0]).toBe("Reflection|Remember the tea");
      expect(readFileSync(join(memoryRoot(s.dir, s.agentId), "system", "human.md"), "utf8")).toBe("Prefers strong tea.\n");
      expect(seen.text).toContain("never coffee");
      // The instructions hold the durable bar.
      expect(seen.text).toContain("leave out one-off details");
      expect(s.events.at(-1)).toMatchObject({ job: "reflection", outcome: "changed", items: { memory_changes: 1 } });
      // The pass's own chat is hidden, so it never shows as a chat.
      expect(s.chats.list().find((c) => c.conversationId === `reflection-${s.agentId}`)?.hidden).toBe(true);
    } finally {
      await s.cleanup();
    }
  });

  test("a pass that keeps nothing leaves memory as it was, and the chat is not read again", async () => {
    const s = await setup();
    try {
      s.faux.setResponses([fauxAssistantMessage("noted"), fauxAssistantMessage("nothing worth keeping")]);
      const before = s.log();
      await s.say(LONG);
      await s.runner.sweep();
      expect(s.log()).toBe(before);
      expect(s.events.at(-1)).toMatchObject({ outcome: "nothing" });
      await s.runner.sweep();
      expect(s.faux.getPendingResponseCount()).toBe(0);
    } finally {
      await s.cleanup();
    }
  });

  test("a compacted chat is reflected on at once, without waiting for it to go quiet", async () => {
    const s = await setup({ quietMs: 60 * 60_000 });
    try {
      const seen = { text: "" };
      const HUGE = LONG.repeat(150);
      // Compaction may also run on its own mid-chat, so each answer is picked by what is asked, not by its turn.
      const answer = (c: { messages: unknown }) => {
        const text = JSON.stringify(c.messages);
        if (!text.includes("since you last reflected on it")) return fauxAssistantMessage("a summary");
        return text.includes("toolResult") ? fauxAssistantMessage("kept") : remember(seen)(c);
      };
      s.faux.setResponses(Array.from({ length: 20 }, () => answer));
      await s.say(HUGE, HUGE, HUGE, HUGE, HUGE, HUGE);
      await s.store.harness.waitForTask(await s.chat.compact(undefined, ctx), ctx);
      await s.runner.sweep();
      expect(s.log().split("\n")[0]).toBe("Reflection|Remember the tea");
    } finally {
      await s.cleanup();
    }
  });

  test("with reflection off nothing runs on its own, but a pass by hand (/reflect) still does", async () => {
    const s = await setup({ enabled: false });
    try {
      const seen = { text: "" };
      s.faux.setResponses([fauxAssistantMessage("noted"), remember(seen), fauxAssistantMessage("kept")]);
      await s.say(LONG);
      await s.runner.sweep();
      expect(s.faux.getPendingResponseCount()).toBe(2);
      expect(await s.runner.runNow("reflection", s.agentId, "c")).toBe("changed");
      expect(s.log().split("\n")[0]).toBe("Reflection|Remember the tea");
    } finally {
      await s.cleanup();
    }
  });
});
