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
import { PassRunner, type PassInput, type PassJob } from "../daemon/passes.ts";
import { PassState } from "../daemon/passes-state.ts";
import { createAgent } from "../daemon/store/agents.ts";

const ctx = BACKGROUND_CONTEXT;
/** Long enough to count as new material (MIN_NEW_CHARS). */
const LONG = "a thought worth keeping about how the river delta builds land over centuries, ".repeat(5);

async function setup(opts: { quietMs?: number; busy?: () => boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "loki-passes-"));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const handle = `${faux.provider.id}/${faux.getModel().id}`;
  const agentId = await createAgent(dir, { name: "Ada", model: handle });
  const registry = createRegistry();
  const open = () => AgentStore.open({ storage: new MemoryStorage() }, { models, registry }, ctx);
  const stores = new StoreManager(join(dir, "stores"), { models, registry }, ctx, () => {}, open);
  const chats = new ChatProjection(ctx, () => "Ada");
  chats.follow(stores);
  const store = await stores.get(agentId);
  await store.setAgent({ id: agentId, name: "Ada" }, ctx);
  const model = { provider: faux.provider.id, modelId: faux.getModel().id };
  const state = new PassState(join(dir, "state"));
  state.setSettings({ reflection: { enabled: true }, learn: { enabled: false } });
  const seen: PassInput[] = [];
  const job: PassJob = {
    name: "reflection",
    chatId: (a) => `reflection-${a}`,
    title: "test pass",
    instructions: "test",
    tools: () => [],
    prompt: (input) => {
      seen.push(input);
      return `read this:\n${input.material}`;
    },
    apply: (_input, answer) => ({ items: { kept: answer.text === "kept" ? 1 : 0 } }),
  };
  const events: Array<Record<string, unknown>> = [];
  const reports: string[] = [];
  const runner = new PassRunner({ stores, chats, registry, state, backendDir: dir, context: ctx, jobs: [job], busy: async () => opts.busy?.() ?? false, isSubagent: () => false, capture: (_e, p) => events.push(p), report: (m) => reports.push(m), quietMs: opts.quietMs ?? 0 });
  const say = async (chatId: string, ...texts: string[]) => {
    const chat = (await store.chat(chatId, ctx)) ?? (await store.createChat(chatId, { agent: { model } }, ctx));
    for (const t of texts) await (await chat.submit({ type: "input", content: t }, ctx)).wait(ctx);
  };
  const cleanup = async () => {
    await stores.closeAll();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, faux, agentId, store, chats, state, runner, seen, events, reports, say, cleanup, open, models, registry };
}

describe("background passes", () => {
  test("a quiet chat with new material gets one run, and the job's cursor ends at the chat's length", async () => {
    const s = await setup();
    try {
      s.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("kept")]);
      await s.say("c", LONG, "and more");
      await s.runner.sweep();
      expect(s.seen).toHaveLength(1);
      expect(s.seen[0].material).toContain("river delta");
      expect(s.state.cursor("reflection", s.agentId, "c")).toBe(s.chats.answers("c", s.agentId, 0).entries);
      expect(s.events.at(-1)).toMatchObject({ job: "reflection", chat: "c", outcome: "changed", items: { kept: 1 } });
      await s.runner.sweep();
      expect(s.seen).toHaveLength(1);
    } finally {
      await s.cleanup();
    }
  });

  test("a stretch too small to hold anything starts no run, and the cursor moves past it", async () => {
    const s = await setup();
    try {
      s.faux.setResponses([fauxAssistantMessage("you're welcome")]);
      await s.say("c", "thanks");
      await s.runner.sweep();
      expect(s.seen).toHaveLength(0);
      expect(s.state.cursor("reflection", s.agentId, "c")).toBe(s.chats.answers("c", s.agentId, 0).entries);
    } finally {
      await s.cleanup();
    }
  });

  test("a chat that is not yet quiet, or is busy, waits; it is read once it settles", async () => {
    let busy = true;
    const s = await setup({ busy: () => busy });
    try {
      s.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("kept")]);
      await s.say("c", LONG);
      await s.runner.sweep();
      expect(s.seen).toHaveLength(0);
      busy = false;
      await s.runner.sweep();
      expect(s.seen).toHaveLength(1);
    } finally {
      await s.cleanup();
    }
    const q = await setup({ quietMs: 60 * 60_000 });
    try {
      q.faux.setResponses([fauxAssistantMessage("one")]);
      await q.say("c", LONG);
      await q.runner.sweep();
      expect(q.seen).toHaveLength(0);
    } finally {
      await q.cleanup();
    }
  });

  test("hidden chats and a job that is off get no runs", async () => {
    const s = await setup();
    try {
      s.state.setSettings({ reflection: { enabled: false } });
      s.faux.setResponses([fauxAssistantMessage("one")]);
      await s.say("c", LONG);
      await s.store.createChat("secret", { title: "x", hidden: true }, ctx);
      await s.runner.sweep();
      expect(s.seen).toHaveLength(0);
    } finally {
      await s.cleanup();
    }
  });

  test("two settled chats are read one after the other, never at once", async () => {
    const s = await setup();
    try {
      let open = 0;
      let most = 0;
      const prompt = s.runner["deps"].jobs[0].prompt;
      s.runner["deps"].jobs[0].prompt = async (input) => {
        open++;
        most = Math.max(most, open);
        await new Promise((r) => setTimeout(r, 20));
        open--;
        return prompt(input);
      };
      s.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("kept"), fauxAssistantMessage("kept")]);
      await s.say("a", LONG);
      await s.say("b", LONG);
      await s.runner.sweep();
      expect(s.seen).toHaveLength(2);
      expect(most).toBe(1);
    } finally {
      await s.cleanup();
    }
  });

  test("a run whose model fails leaves the cursor, is reported, and is not retried until another quiet spell", async () => {
    const s = await setup();
    try {
      s.faux.setResponses([fauxAssistantMessage("one")]);
      await s.say("c", LONG);
      await s.runner.sweep();
      expect(s.reports.some((r) => r.startsWith("reflection on c failed"))).toBe(true);
      expect(s.state.cursor("reflection", s.agentId, "c")).toBeUndefined();
      expect(s.events.at(-1)).toMatchObject({ outcome: "failed" });
      const tried = s.seen.length;
      s.runner["deps"].quietMs = 60 * 60_000;
      await s.runner.sweep();
      expect(s.seen).toHaveLength(tried);
    } finally {
      await s.cleanup();
    }
  });

  test("a new runner over the same state neither rereads a finished stretch nor loses an unread one", async () => {
    const s = await setup();
    try {
      s.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("kept"), fauxAssistantMessage("two"), fauxAssistantMessage("kept")]);
      await s.say("c", `FIRST ${LONG}`);
      await s.runner.sweep();
      await s.say("c", `SECOND ${LONG}`);
      const again = new PassRunner({ ...s.runner["deps"], state: new PassState(join(s.dir, "state")) });
      await again.sweep();
      expect(s.seen).toHaveLength(2);
      expect(s.seen[1].material).toContain("SECOND");
      expect(s.seen[1].material).not.toContain("FIRST");
    } finally {
      await s.cleanup();
    }
  });

  test("run now reads a chat at once, even with the job off", async () => {
    const s = await setup({ quietMs: 60 * 60_000 });
    try {
      s.state.setSettings({ reflection: { enabled: false } });
      s.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("kept")]);
      await s.say("c", "short");
      expect(await s.runner.runNow("reflection", s.agentId, "c")).toBe("changed");
      expect(s.seen).toHaveLength(1);
    } finally {
      await s.cleanup();
    }
  });

  test("a compacted chat is read by a job that follows compaction without waiting for the quiet spell", async () => {
    const s = await setup({ quietMs: 60 * 60_000 });
    try {
      s.runner["deps"].jobs[0].onCompaction = true;
      s.faux.setResponses([...["1", "2", "3", "4", "5", "6"].map((t) => fauxAssistantMessage(t)), fauxAssistantMessage("a summary"), fauxAssistantMessage("kept")]);
      const HUGE = LONG.repeat(150);
      await s.say("c", HUGE, HUGE, HUGE, HUGE, HUGE, HUGE);
      const chat = (await s.store.chat("c", ctx))!;
      await s.store.harness.waitForTask(await chat.compact(undefined, ctx), ctx);
      await s.runner.sweep();
      expect(s.seen).toHaveLength(1);
    } finally {
      await s.cleanup();
    }
  });

  test("/reflect while a sweep is running waits its turn in the same queue: runs never overlap, and the same run is not queued twice", async () => {
    const s = await setup();
    try {
      let open = 0;
      let most = 0;
      const prompt = s.runner["deps"].jobs[0].prompt;
      s.runner["deps"].jobs[0].prompt = async (input) => {
        open++;
        most = Math.max(most, open);
        await new Promise((r) => setTimeout(r, 30));
        open--;
        return prompt(input);
      };
      s.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("kept"), fauxAssistantMessage("kept")]);
      await s.say("a", LONG);
      await s.say("b", LONG);
      const sweep = s.runner.sweep();
      const [byHand, again] = await Promise.all([s.runner.runNow("reflection", s.agentId, "b"), s.runner.runNow("reflection", s.agentId, "b")]);
      await sweep;
      expect(most).toBe(1);
      expect(s.seen).toHaveLength(2);
      expect(([byHand, again] as string[]).sort()).toEqual(["changed", "skipped"]);
    } finally {
      await s.cleanup();
    }
  });

  test("a chat that wakes while its run waits in the queue is left for later, its cursor where it was", async () => {
    let busyChat: string | null = null;
    const s = await setup({ busy: () => false });
    try {
      s.runner["deps"].busy = async (_a: string, chat: string) => chat === busyChat;
      const prompt = s.runner["deps"].jobs[0].prompt;
      s.runner["deps"].jobs[0].prompt = async (input) => {
        busyChat = "b"; // the person comes back to b while a is being read
        return prompt(input);
      };
      s.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("kept")]);
      await s.say("a", LONG);
      await s.say("b", LONG);
      await s.runner.sweep();
      expect(s.seen.map((i) => i.chatId)).toEqual(["a"]);
      expect(s.state.cursor("reflection", s.agentId, "b")).toBeUndefined();
    } finally {
      await s.cleanup();
    }
  });

  test("a stretch longer than one run reads is read over several runs, oldest first, and none of it is skipped", async () => {
    const s = await setup();
    try {
      const big = (tag: string) => `${tag} ${"the delta grows where the river slows. ".repeat(300)}`; // about 11k characters each
      s.faux.setResponses(Array.from({ length: 12 }, () => fauxAssistantMessage("kept")));
      await s.say("c", big("FIRST"), big("SECOND"), big("THIRD"));
      for (let i = 0; i < 4 && (s.state.cursor("reflection", s.agentId, "c") ?? 0) < s.chats.answers("c", s.agentId, 0).entries; i++) await s.runner.sweep();
      const read = s.seen.map((i) => i.material).join("\n");
      for (const tag of ["FIRST", "SECOND", "THIRD"]) expect(read).toContain(tag);
      expect(s.seen.length).toBeGreaterThan(1);
      expect(s.seen[0].material).toContain("FIRST");
      expect(s.seen[0].material.length).toBeLessThanOrEqual(24_000);
      expect(s.state.cursor("reflection", s.agentId, "c")).toBe(s.chats.answers("c", s.agentId, 0).entries);
    } finally {
      await s.cleanup();
    }
  });

  test("Learn's Run now reads every chat with something new, even with the job off, and leaves a busy one", async () => {
    const s = await setup({ quietMs: 60 * 60_000 });
    try {
      s.state.setSettings({ reflection: { enabled: false } });
      s.runner["deps"].busy = async (_a: string, chat: string) => chat === "b";
      s.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("kept")]);
      await s.say("a", LONG);
      await s.say("b", LONG);
      await s.runner.runAllNow("reflection");
      expect(s.seen.map((i) => i.chatId)).toEqual(["a"]);
      expect(s.state.cursor("reflection", s.agentId, "a")).toBe(s.chats.answers("a", s.agentId, 0).entries);
      expect(s.state.cursor("reflection", s.agentId, "b")).toBeUndefined();
    } finally {
      await s.cleanup();
    }
  });
});
