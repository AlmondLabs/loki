import { describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, MemoryStorage, type CommitPublication } from "@earendil-works/pi-durable";
import { hourOf } from "../core/usage.ts";
import { AgentStore } from "../daemon/kernel/index.ts";
import { UsageLedger, originOfChat } from "../daemon/usage.ts";

const ctx = BACKGROUND_CONTEXT;
const NOW = Date.parse("2026-10-17T14:25:00Z");
const MODEL = "anthropic/claude-sonnet-5-5";

/** A `pi.usage` entry with these counters, cost a cent per thousand tokens of each kind. */
const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  totalTokens: input + output + cacheRead + cacheWrite,
  cost: {
    input: input / 1e5,
    output: output / 1e5,
    cacheRead: cacheRead / 1e5,
    cacheWrite: cacheWrite / 1e5,
    total: (input + output + cacheRead + cacheWrite) / 1e5,
  },
});

/**
 * A store that holds chats `chats` (conversation id → chat id, undefined for a helper's child conversation) with
 * totals `totals`, and lets a test publish `pi.usage` changes as pi-durable would.
 */
function fakeStore(chats: Record<number, string | undefined>, totals: Partial<Record<number, Record<string, ReturnType<typeof usage>>>> = {}) {
  let listener: ((p: CommitPublication) => void) | null = null;
  const store = {
    harness: {
      subscribeCommits: (l: (p: CommitPublication) => void) => {
        listener = l;
        return () => (listener = null);
      },
    },
    chatConversations: () => Promise.resolve(Object.keys(chats).map(Number)),
    usage: (id: number) => Promise.resolve(totals[id] ? { models: totals[id], tools: {} } : undefined),
    chatInfo: (id: number) => Promise.resolve(chats[id] === undefined ? undefined : { id: chats[id] }),
  } as unknown as AgentStore;
  /** pi-durable's commit of conversation `id`'s new totals; `created` for the commit that made the document. */
  const publish = (id: number, models: Record<string, ReturnType<typeof usage>>, created = false) => {
    listener?.({
      seq: 1,
      changes: [
        {
          type: "document",
          record: { kind: "pi.usage" },
          conversationId: id,
          version: 1,
          value: { models, tools: {} },
          ops: created ? [] : [["s", ["models"], models]],
        },
      ],
    } as unknown as CommitPublication);
  };
  return { store, publish };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "loki-usage-"));
  const file = join(dir, "usage.json");
  let now = NOW;
  const make = () => new UsageLedger({ file, context: ctx, inputRate: (m) => (m === MODEL ? 3 : null), now: () => now, saveDelayMs: 0 });
  return {
    dir,
    file,
    make,
    setNow: (ms: number) => (now = ms),
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The usage ledger (daemon/usage.ts): what each call cost, by hour, agent, model and origin. */
describe("the usage ledger", () => {
  test("a chat's totals from before the ledger are history; only what grows after counts, in the hour it grows", async () => {
    const s = setup();
    try {
      const ledger = s.make();
      const { store, publish } = fakeStore({ 5: "local-conv-1" }, { 5: { [MODEL]: usage(1000, 100) } });
      ledger.attach("a1", store);
      await ledger.settled();
      expect(ledger.rows()).toEqual([]);
      publish(5, { [MODEL]: usage(1500, 160, 4000, 0) });
      await ledger.settled();
      const [row] = ledger.rows();
      expect(row).toMatchObject({ hour: "2026-10-17T14:00:00.000Z", agent_id: "a1", model: MODEL, origin: "chats" });
      expect(row).toMatchObject({ input_tokens: 500, output_tokens: 60, cache_read_tokens: 4000, cache_write_tokens: 0 });
      expect(row.cost.total).toBeCloseTo(4560 / 1e5);
      expect(row.cost.cache_read).toBeCloseTo(4000 / 1e5);
      // 4,000 cache reads at the model's $3 a million input price.
      expect(row.cache_read_as_input).toBeCloseTo(0.012);
    } finally {
      s.cleanup();
    }
  });

  test("a new conversation counts from zero, a later hour gets its own row, and a chat first seen mid-life counts nothing", async () => {
    const s = setup();
    try {
      const ledger = s.make();
      const { store, publish } = fakeStore({ 5: "local-conv-1" });
      ledger.attach("a1", store);
      await ledger.settled();
      publish(9, {}, true);
      publish(9, { [MODEL]: usage(200, 20) });
      s.setNow(NOW + 3_600_000);
      publish(9, { [MODEL]: usage(300, 50) });
      // Conversation 12 was never seen and this is not its creation: what it holds so far is history.
      publish(12, { [MODEL]: usage(9999, 999) });
      await ledger.settled();
      expect(ledger.rows().map((r) => [r.hour, r.input_tokens, r.output_tokens])).toEqual([
        ["2026-10-17T14:00:00.000Z", 200, 20],
        ["2026-10-17T15:00:00.000Z", 100, 30],
      ]);
    } finally {
      s.cleanup();
    }
  });

  test("calls are told apart by origin: the person's chats, helpers, and each background pass", async () => {
    const s = setup();
    try {
      const ledger = s.make();
      const { store, publish } = fakeStore({ 1: "local-conv-1", 2: "reflection-a1", 3: "recall-a1", 4: "doctor-a1", 6: "default" });
      ledger.attach("a1", store);
      await ledger.settled();
      for (const id of [1, 2, 3, 4, 6]) publish(id, { [MODEL]: usage(10, 1) });
      publish(7, {}, true); // a helper's child conversation: no chat of loki's
      publish(7, { [MODEL]: usage(10, 1) });
      await ledger.settled();
      const byOrigin = Object.fromEntries(ledger.rows().map((r) => [r.origin, r.input_tokens]));
      expect(byOrigin).toEqual({ chats: 20, reflection: 10, learn: 10, doctor: 10, helpers: 10 });
      expect(originOfChat("reflection-a2", "a1")).toBe("chats");
    } finally {
      s.cleanup();
    }
  });

  test("listeners hear when the ledger counts more, and not when nothing grew", async () => {
    const s = setup();
    try {
      const ledger = s.make();
      await ledger.settled(); // the seed, which tells listeners too
      let heard = 0;
      const off = ledger.onChange(() => heard++);
      const { store, publish } = fakeStore({ 5: "local-conv-1" }, { 5: { [MODEL]: usage(10, 1) } });
      ledger.attach("a1", store);
      await ledger.settled();
      publish(5, { [MODEL]: usage(10, 1) });
      await ledger.settled();
      expect(heard).toBe(0);
      publish(5, { [MODEL]: usage(20, 1) });
      await ledger.settled();
      expect(heard).toBe(1);
      off();
      publish(5, { [MODEL]: usage(30, 1) });
      await ledger.settled();
      expect(heard).toBe(1);
    } finally {
      s.cleanup();
    }
  });

  test("a restart counts nothing twice, and rows older than 400 days are dropped", async () => {
    const s = setup();
    try {
      const first = s.make();
      const a = fakeStore({ 5: "local-conv-1" });
      first.attach("a1", a.store);
      await first.settled();
      a.publish(5, { [MODEL]: usage(100, 10) });
      await first.settled();
      first.close();

      const second = s.make();
      const b = fakeStore({ 5: "local-conv-1" }, { 5: { [MODEL]: usage(100, 10) } });
      second.attach("a1", b.store);
      await second.settled();
      b.publish(5, { [MODEL]: usage(130, 12) });
      await second.settled();
      expect(second.rows().map((r) => [r.input_tokens, r.output_tokens])).toEqual([[130, 12]]);
      second.close();

      const file = JSON.parse(readFileSync(s.file, "utf8")) as { rows: Array<{ hour: string }> };
      file.rows.unshift({ ...file.rows[0], hour: hourOf(NOW - 401 * 86_400_000) });
      writeFileSync(s.file, JSON.stringify(file));
      expect(s.make().rows()).toHaveLength(1);
    } finally {
      s.cleanup();
    }
  });

  test("a real chat's turn lands in the ledger under the chat's agent and model", async () => {
    const s = setup();
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const store = await AgentStore.open({ storage: new MemoryStorage() }, { models, registry: createRegistry() }, ctx);
    try {
      const ledger = s.make();
      ledger.attach("a1", store);
      const chat = await store.createChat("local-conv-1", { agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } } }, ctx);
      faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
      await (await chat.submit({ type: "input", content: "hi" }, ctx)).wait(ctx);
      await (await chat.submit({ type: "input", content: "again" }, ctx)).wait(ctx);
      await ledger.settled();
      const totals = (await store.usage(chat.id, ctx))?.models[`${faux.provider.id}/${faux.getModel().id}`];
      const [row] = ledger.rows();
      expect(row).toMatchObject({ agent_id: "a1", model: `${faux.provider.id}/${faux.getModel().id}`, origin: "chats" });
      expect(row.input_tokens).toBe(totals?.input);
      expect(row.output_tokens).toBe(totals?.output);
    } finally {
      await store.close(ctx);
      s.cleanup();
    }
  });

  test("history is seeded once from analytics' turn_finished lines, before the ledger began, its cost as other", async () => {
    const s = setup();
    try {
      const line = (timestamp: string, properties: Record<string, unknown>) =>
        JSON.stringify({ event: "turn_finished", timestamp, distinct_id: "x", properties });
      const turn = {
        agent: "a1",
        model: MODEL,
        input_tokens: 100,
        output_tokens: 10,
        cache_read_tokens: 1000,
        cache_write_tokens: 0,
        reasoning_tokens: 4,
        cost: 0.02,
      };
      const older = join(s.dir, "events.jsonl.1");
      const newer = join(s.dir, "events.jsonl");
      writeFileSync(older, `${line("2026-10-01T09:10:00.000Z", { ...turn, origin: "message" })}\nnot json\n`);
      writeFileSync(
        newer,
        [
          line("2026-10-01T09:50:00.000Z", { ...turn, origin: "schedule" }),
          line("2026-10-02T03:00:00.000Z", { ...turn, origin: "reflection" }),
          JSON.stringify({ event: "view_opened", timestamp: "2026-10-02T03:00:00.000Z", properties: { view: "chats" } }),
          // After the ledger began: the ledger counts it itself.
          line("2026-10-17T14:30:00.000Z", { ...turn, origin: "message" }),
        ].join("\n"),
      );
      const ledger = new UsageLedger({ file: s.file, context: ctx, inputRate: () => 3, now: () => NOW, saveDelayMs: 0, eventsFiles: [older, newer] });
      await ledger.settled();
      expect(ledger.seeded()).toBe(new Date(NOW).toISOString());
      const rows = ledger.rows();
      expect(rows.map((r) => [r.hour, r.origin, r.input_tokens, r.cache_read_tokens])).toEqual([
        ["2026-10-01T09:00:00.000Z", "chats", 200, 2000],
        ["2026-10-02T03:00:00.000Z", "reflection", 100, 1000],
      ]);
      expect(rows[0].cost).toEqual({ input: 0, cache_read: 0, cache_write: 0, output: 0, other: 0.04, total: 0.04 });
      expect(rows[0].cache_read_as_input).toBeCloseTo(0.006);
      ledger.close();
      // Seeded once: the next start reads the file and seeds nothing more.
      const again = new UsageLedger({ file: s.file, context: ctx, inputRate: () => 3, now: () => NOW, saveDelayMs: 0, eventsFiles: [older, newer] });
      await again.settled();
      expect(again.rows()).toEqual(rows);
    } finally {
      s.cleanup();
    }
  });

  test("a ledger that ran before the seed existed seeds only what came before its first row; no analytics seeds nothing", async () => {
    const s = setup();
    try {
      writeFileSync(
        s.file,
        JSON.stringify({
          version: 1,
          seen: {},
          rows: [
            { ...emptyRowFor("2026-10-10T08:00:00.000Z"), input_tokens: 5, cost: { input: 0, cache_read: 0, cache_write: 0, output: 0, other: 0, total: 0 } },
          ],
        }),
      );
      const events = join(s.dir, "events.jsonl");
      const line = (timestamp: string) =>
        JSON.stringify({
          event: "turn_finished",
          timestamp,
          properties: { agent: "a1", model: MODEL, origin: "message", input_tokens: 7, output_tokens: 1, cost: 0 },
        });
      writeFileSync(events, [line("2026-10-10T07:59:00.000Z"), line("2026-10-10T08:01:00.000Z")].join("\n"));
      const ledger = new UsageLedger({ file: s.file, context: ctx, inputRate: () => null, now: () => NOW, saveDelayMs: 0, eventsFiles: [events] });
      await ledger.settled();
      expect(ledger.rows().map((r) => [r.hour, r.input_tokens])).toEqual([
        ["2026-10-10T07:00:00.000Z", 7],
        ["2026-10-10T08:00:00.000Z", 5],
      ]);
      const none = new UsageLedger({
        file: join(s.dir, "fresh.json"),
        context: ctx,
        inputRate: () => null,
        now: () => NOW,
        saveDelayMs: 0,
        eventsFiles: [join(s.dir, "missing")],
      });
      await none.settled();
      expect(none.rows()).toEqual([]);
      expect(none.seeded()).not.toBeNull();
    } finally {
      s.cleanup();
    }
  });
});

/** A row of agent a1's calls to MODEL from the person's chats in `hour`, with nothing in it yet. */
function emptyRowFor(hour: string) {
  return {
    hour,
    agent_id: "a1",
    model: MODEL,
    origin: "chats",
    input_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cache_read_as_input: 0,
  };
}
