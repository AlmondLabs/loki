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
import { must } from "./fixtures/must.ts";

const ctx = BACKGROUND_CONTEXT;
/** Long enough to count as new material (MIN_NEW_CHARS). */
const LONG = "a thought worth keeping about how the river delta builds land over centuries, ".repeat(5);

async function setup(opts: { quietMs?: number; busy?: () => boolean; canRun?: () => boolean } = {}) {
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
  chats.follow(stores, () => {});
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
  const runner = new PassRunner({
    stores,
    chats,
    registry,
    state,
    backendDir: dir,
    context: ctx,
    jobs: [job],
    busy: () => Promise.resolve(opts.busy?.() ?? false),
    ...(opts.canRun ? { canRun: () => Promise.resolve(opts.canRun?.() ?? true) } : {}),
    capture: (_e, p) => events.push(p),
    report: (m) => reports.push(m),
    quietMs: opts.quietMs ?? 0,
  });
  const say = async (chatId: string, ...texts: string[]) => {
    const chat = (await store.chat(chatId, ctx)) ?? (await store.createChat(chatId, { agent: { model } }, ctx));
    for (const t of texts) await (await chat.submit({ type: "input", content: t }, ctx)).wait(ctx);
  };
  /** A chat on an ACP agent (plan 020): its turns are written straight into the store, never run by pi. */
  const acpSay = async (chatId: string, text: string, reply: string) => {
    const chat = (await store.chat(chatId, ctx)) ?? (await store.createChat(chatId, {}, ctx));
    await store.updateChat(chatId, { engine: { kind: "acp", agent: "claude-code", model: "default", session_id: "s-1" } }, ctx);
    // Both in the past, as a finished turn's are: a reply stamped ahead of the clock is not quiet yet.
    const at = Date.now() - 10;
    await store.appendEntries(
      chat,
      [
        { kind: "pi.user", message: { role: "user", content: [{ type: "text", text }], timestamp: at } },
        { kind: "pi.assistant", message: { role: "assistant", content: [{ type: "text", text: reply }], timestamp: at + 1 } },
      ],
      null,
      ctx,
    );
  };
  const cleanup = async () => {
    await stores.closeAll();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, faux, agentId, store, chats, state, runner, seen, events, reports, say, acpSay, cleanup, open, models, registry };
}

describe("background passes", () => {
  test("every chat is read on the Mac it lives on, its agent's home or not, and its memory root reaches the job", async () => {
    const s = await setup();
    try {
      s.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("kept")]);
      await s.say("c", LONG, "and more");
      await s.runner.sweep();
      expect(s.seen).toHaveLength(1);
      expect(s.seen[0].memoryRoot).toBe(join(s.dir, "memfs", s.agentId, "memory"));
    } finally {
      await s.cleanup();
    }
  });

  test("a chat on an ACP agent is read like any other, and the pass runs on the agent's own model", async () => {
    const s = await setup();
    try {
      s.faux.setResponses([fauxAssistantMessage("kept")]);
      await s.acpSay("cc", LONG, "noted, from Claude Code");
      await s.runner.sweep();
      expect(s.seen).toHaveLength(1);
      expect(s.seen[0].material).toContain("river delta");
      expect(s.seen[0].material).toContain("noted, from Claude Code");
      expect(s.events.at(-1)).toMatchObject({ chat: "cc", outcome: "changed", items: { kept: 1 } });
    } finally {
      await s.cleanup();
    }
  });

  test("with no model loki can reach, passes wait quietly and read nothing; the memory review says why", async () => {
    let reachable = false;
    const s = await setup({ canRun: () => reachable });
    try {
      await s.acpSay("cc", LONG, "noted");
      await s.runner.sweep();
      await s.runner.sweep();
      expect(s.seen).toHaveLength(0);
      expect(s.reports).toEqual([]);
      expect(s.events).toEqual([]);
      expect(s.state.cursor("reflection", s.agentId, "cc") ?? 0).toBe(0);
      const review = await s.runner.runDoctor(s.agentId);
      expect(review.outcome).toBe("skipped");
      expect(review.report).toMatch(/Preferences › Providers/);
      reachable = true;
      s.faux.setResponses([fauxAssistantMessage("kept")]);
      await s.runner.sweep();
      expect(s.seen).toHaveLength(1);
    } finally {
      await s.cleanup();
    }
  });

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

  test("a pass's prompt carries the Mac's time after it: nothing else in its chat says what day it is (plan 057)", async () => {
    const s = await setup();
    try {
      let saw = "";
      s.faux.setResponses([
        fauxAssistantMessage("one"),
        (context: { messages: unknown[] }) => ((saw = JSON.stringify(context.messages)), fauxAssistantMessage("kept")),
      ]);
      await s.say("c", LONG);
      await s.runner.sweep();
      expect(saw).toContain("read this:");
      expect(saw).toContain("Local time on the user's Mac, as loki sends this:");
      expect(saw.indexOf("read this:")).toBeLessThan(saw.indexOf("Local time on the user's Mac"));
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

  test("an agent's settled chats are read in one run, each its own part, and each chat's cursor moves to its end", async () => {
    const s = await setup();
    try {
      s.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("kept")]);
      await s.say("a", `ALPHA ${LONG}`);
      await s.say("b", `BRAVO ${LONG}`);
      await s.runner.sweep();
      expect(s.seen).toHaveLength(1);
      expect(s.seen[0].parts.map((p) => p.chatId)).toEqual(["a", "b"]); // the one quiet longest first
      expect(s.seen[0].material).toMatch(/<conversation n="1">[\s\S]*ALPHA[\s\S]*<\/conversation>\n\n<conversation n="2">[\s\S]*BRAVO/);
      for (const c of ["a", "b"]) expect(s.state.cursor("reflection", s.agentId, c)).toBe(s.chats.answers(c, s.agentId, 0).entries);
      expect(s.events.at(-1)).toMatchObject({ outcome: "changed", chats: ["a", "b"] });
    } finally {
      await s.cleanup();
    }
  });

  test("an agent's next batch waits out the gap, so chats gather; one that left chats behind goes again at once", async () => {
    const s = await setup();
    try {
      s.runner["deps"].batchEveryMs = 60 * 60_000;
      s.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("kept"), fauxAssistantMessage("two"), fauxAssistantMessage("kept")]);
      await s.say("a", LONG);
      await s.runner.sweep();
      expect(s.seen).toHaveLength(1);
      await s.say("b", LONG);
      await s.runner.sweep();
      expect(s.seen).toHaveLength(1); // b waits for the gap
      s.runner["deps"].batchEveryMs = 0;
      await s.runner.sweep();
      expect(s.seen.map((i) => i.parts.map((p) => p.chatId))).toEqual([["a"], ["b"]]);
    } finally {
      await s.cleanup();
    }
  });

  test("a batch reads whole stretches up to its limit; the chats that do not fit go in the next batch, without the gap", async () => {
    const s = await setup();
    try {
      s.runner["deps"].batchEveryMs = 60 * 60_000;
      const big = (tag: string) => `${tag} ${"the delta grows where the river slows. ".repeat(560)}`; // about 21k characters
      s.faux.setResponses(Array.from({ length: 12 }, () => fauxAssistantMessage("kept")));
      for (const c of ["a", "b", "c", "d", "e"]) await s.say(c, big(c.toUpperCase()));
      await s.runner.sweep();
      const first = s.seen[0].parts.map((p) => p.chatId);
      expect(first.length).toBeGreaterThan(1);
      expect(first.length).toBeLessThan(5);
      expect(s.seen[0].material.length).toBeLessThanOrEqual(80_000 + 500);
      await s.runner.sweep(); // the rest at once: the last batch left them
      const read = s.seen.flatMap((i) => i.parts.map((p) => p.chatId));
      expect(read.sort()).toEqual(["a", "b", "c", "d", "e"]);
      for (const c of ["a", "b", "c", "d", "e"]) expect(s.state.cursor("reflection", s.agentId, c)).toBe(s.chats.answers(c, s.agentId, 0).entries);
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

  test("a failed run tried again asks the model again rather than getting the old submission back", async () => {
    const s = await setup();
    try {
      s.faux.setResponses([fauxAssistantMessage("one")]);
      await s.say("c", LONG);
      await s.runner.sweep();
      expect(s.events.at(-1)).toMatchObject({ outcome: "failed" });
      s.faux.appendResponses([fauxAssistantMessage("kept")]);
      await s.runner.sweep();
      expect(s.events.at(-1)).toMatchObject({ outcome: "changed", items: { kept: 1 } });
      expect(must(s.events.at(-1), "the last event").request_id).not.toBe(must(s.events.at(-2), "the event before").request_id);
      expect(s.faux.getPendingResponseCount()).toBe(0);
    } finally {
      await s.cleanup();
    }
  });

  test("a run that hangs is stopped past its limit and counted as failed, and the queue moves on", async () => {
    const s = await setup({ quietMs: 60 * 60_000 });
    try {
      s.runner["deps"].runTimeoutMs = 100;
      const hang = (_c: unknown, options: { signal?: AbortSignal } | undefined) =>
        new Promise<never>((_r, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      s.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), hang, fauxAssistantMessage("kept")]);
      await s.say("a", LONG);
      await s.say("b", LONG);
      const outcomes = await Promise.all([s.runner.runNow("reflection", s.agentId, "a"), s.runner.runNow("reflection", s.agentId, "b")]);
      expect(outcomes).toEqual(["failed", "changed"]);
      expect(s.events.map((e) => [e.chat, e.outcome])).toEqual([
        ["a", "failed"],
        ["b", "changed"],
      ]);
      expect(s.reports.some((r) => r.includes("did not finish within"))).toBe(true);
    } finally {
      await s.cleanup();
    }
  });

  test("a run whose checks throw still settles its caller, as failed", async () => {
    const s = await setup();
    try {
      s.faux.setResponses([fauxAssistantMessage("one")]);
      await s.say("c", LONG);
      s.runner["deps"].busy = () => Promise.reject(new Error("no doc"));
      expect(await s.runner.runNow("reflection", s.agentId, "c")).toBe("failed");
      expect(s.events.at(-1)).toMatchObject({ outcome: "failed" });
    } finally {
      await s.cleanup();
    }
  });

  test("a run with nothing new still records how it ended", async () => {
    const s = await setup();
    try {
      s.faux.setResponses([fauxAssistantMessage("one")]);
      await s.say("c", LONG);
      s.state.setCursor("reflection", s.agentId, "c", s.chats.answers("c", s.agentId, 0).entries);
      expect(await s.runner.runNow("reflection", s.agentId, "c")).toBe("nothing");
      expect(s.events.at(-1)).toMatchObject({ outcome: "nothing", entries_read: 0 });
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
      s.faux.setResponses([
        ...["1", "2", "3", "4", "5", "6"].map((t) => fauxAssistantMessage(t)),
        fauxAssistantMessage("a summary"),
        fauxAssistantMessage("kept"),
      ]);
      const HUGE = LONG.repeat(150);
      await s.say("c", HUGE, HUGE, HUGE, HUGE, HUGE, HUGE);
      const chat = must(await s.store.chat("c", ctx), "chat c");
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
      const job = s.runner["deps"].jobs[0];
      const prompt = job.prompt.bind(job);
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
    const s = await setup({ quietMs: 60 * 60_000, busy: () => false });
    try {
      s.runner["deps"].busy = (_a: string, chat: string) => Promise.resolve(chat === busyChat);
      const job = s.runner["deps"].jobs[0];
      const prompt = job.prompt.bind(job);
      s.runner["deps"].jobs[0].prompt = async (input) => {
        busyChat = "b"; // the person comes back to b while a is being read
        return prompt(input);
      };
      s.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("kept")]);
      await s.say("a", LONG);
      await s.say("b", LONG);
      const outcomes = await Promise.all([s.runner.runNow("reflection", s.agentId, "a"), s.runner.runNow("reflection", s.agentId, "b")]);
      expect(outcomes).toEqual(["changed", "skipped"]);
      expect(s.seen.map((i) => i.parts.map((p) => p.chatId))).toEqual([["a"]]);
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
      s.runner["deps"].busy = (_a: string, chat: string) => Promise.resolve(chat === "b");
      s.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("kept")]);
      await s.say("a", LONG);
      await s.say("b", LONG);
      await s.runner.runAllNow("reflection");
      expect(s.seen.map((i) => i.parts.map((p) => p.chatId))).toEqual([["a"]]);
      expect(s.state.cursor("reflection", s.agentId, "a")).toBe(s.chats.answers("a", s.agentId, 0).entries);
      expect(s.state.cursor("reflection", s.agentId, "b")).toBeUndefined();
    } finally {
      await s.cleanup();
    }
  });
});
