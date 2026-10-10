import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, MemoryStorage, watchEvents } from "@earendil-works/pi-durable";
import { AgentStore } from "../daemon/kernel/index.ts";
import { ChatEventConverter } from "../daemon/chat-events.ts";
import { TurnTelemetry, harnessVersion, originOf, turnIdOf, turnProperties, type FinishedTurn } from "../daemon/telemetry.ts";
import type { ChatEvent } from "../core/attention/model.ts";

const ctx = BACKGROUND_CONTEXT;
const T0 = 1_000_000;

const usage = (input: number, output: number, cacheRead: number, cacheWrite: number, cost: number, reasoning?: number) => ({ input, output, cacheRead, cacheWrite, ...(reasoning === undefined ? {} : { reasoning }), totalTokens: input + output + cacheRead + cacheWrite, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } });
const turn = (over: Partial<FinishedTurn> = {}): FinishedTurn => ({
  agentId: "agent-local-a",
  chatId: "local-conv-1",
  hidden: false,
  title: null,
  turnId: "agent-local-a:7",
  requestId: null,
  entries: [
    { kind: "pi.user", model: [{ role: "user", content: "hello", timestamp: T0 } as never] },
    // The model from 100 to 1100, a tool from 1150 to 1650 that failed, the model again from 1700 to 2200.
    { kind: "pi.assistant", model: [{ role: "assistant", provider: "openai", model: "gpt-x", content: [], timestamp: T0 + 100, durationMs: 1000, stopReason: "toolUse", usage: usage(1000, 50, 0, 1000, 0.01, 20) } as never] },
    { kind: "pi.tool", model: [{ role: "toolResult", toolCallId: "t1", toolName: "read", content: [], isError: true, timestamp: T0 + 1650, durationMs: 500 } as never] },
    { kind: "pi.assistant", model: [{ role: "assistant", provider: "openai", model: "gpt-x", content: [], timestamp: T0 + 1700, durationMs: 500, stopReason: "stop", usage: usage(100, 30, 2000, 0, 0.002) } as never] },
  ],
  startedAt: T0,
  firstOutputAt: T0 + 400,
  endedAt: T0 + 2300,
  failure: null,
  agentIsSubagent: false,
  harnessVersion: "abc1234",
  model: "openai/other",
  ...over,
});

describe("turn telemetry: one turn's event", () => {
  test("tokens and cost sum over the turn's responses, and its time splits into model, tool and harness", () => {
    expect(turnProperties(turn())).toEqual({
      desk: "local-conv-1",
      chat: "local-conv-1",
      agent: "agent-local-a",
      model: "openai/gpt-x",
      harness_version: "abc1234",
      turn_id: "agent-local-a:7",
      origin: "message",
      input_tokens: 1100,
      output_tokens: 80,
      cache_read_tokens: 2000,
      cache_write_tokens: 1000,
      reasoning_tokens: 20,
      cache_share: 0.488,
      cost: 0.012,
      responses: 2,
      ttft_ms: 400,
      total_ms: 2300,
      model_ms: 1500,
      tool_ms: 500,
      overhead_ms: 300,
      tool_calls: 1,
      tool_failures: 1,
      stop_reason: "stop",
      error: false,
      error_code: null,
    });
  });

  test("a turn that failed says so with a short code, never the message; one with no response names the chat's model", () => {
    const failed = turnProperties(turn({ entries: turn().entries.slice(0, 1), failure: "no_model", firstOutputAt: null }));
    expect(failed).toMatchObject({ error: true, error_code: "no_model", model: "openai/other", responses: 0, ttft_ms: null, cache_share: null, stop_reason: null });
    expect(turnProperties(turn({ failure: "Provider said: rate limited (429)" })).error_code).toBe("other");
    const aborted = turn().entries.map((e, i) => (i === 3 ? { ...e, model: [{ ...(e.model![0] as object), stopReason: "aborted" } as never] } : e));
    expect(turnProperties(turn({ entries: aborted }))).toMatchObject({ error: true, error_code: "aborted", stop_reason: "aborted" });
  });

  test("where a turn came from: you, a schedule, a task's notice, a helper, Learn's writer, reflection", () => {
    const first = (text: string) => [{ kind: "pi.user", model: [{ role: "user", content: text, timestamp: T0 } as never] }];
    expect(originOf(turn())).toBe("message");
    expect(originOf(turn({ entries: first("Scheduled task: water the plants") }))).toBe("schedule");
    expect(originOf(turn({ entries: first("<task-notification>\n<task-id>1</task-id>") }))).toBe("background");
    expect(originOf(turn({ requestId: "subagent:12" }))).toBe("subagent");
    expect(originOf(turn({ agentIsSubagent: true }))).toBe("subagent");
    expect(originOf(turn({ chatId: "recall-agent-local-a" }))).toBe("recall");
    expect(originOf(turn({ chatId: "c9", hidden: true, title: "recall" }))).toBe("recall");
    expect(originOf(turn({ chatId: "reflection-local-conv-1" }))).toBe("reflection");
    // A background pass's run says its job in the request id.
    expect(originOf(turn({ chatId: "recall-agent-local-a", requestId: "pass:learn:c1:12" }))).toBe("recall");
    expect(originOf(turn({ chatId: "reflection-agent-local-a", requestId: "pass:reflection:c1:12" }))).toBe("reflection");
  });

  test("a background pass's turn carries its request id, so its pass_finished line can be joined to it; other turns do not", () => {
    expect(turnProperties(turn({ chatId: "recall-agent-local-a", requestId: "pass:learn:c1:12" })).request_id).toBe("pass:learn:c1:12");
    expect(turnProperties(turn({ requestId: "subagent:3" })).request_id).toBeUndefined();
  });

  test("a turn's id is its agent and the submission that opened it", () => {
    expect(turnIdOf("agent-local-a", [7, 8])).toBe("agent-local-a:7");
    expect(turnIdOf("agent-local-a", [])).toBeNull();
  });

  test("the harness version: a checkout's commit, else loki's version", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-harness-version-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "2026.10.10" }));
      const before = process.env.LOKI_VERSION;
      delete process.env.LOKI_VERSION;
      try {
        expect(harnessVersion(dir)).toBe("2026.10.10");
      } finally {
        if (before !== undefined) process.env.LOKI_VERSION = before;
      }
      expect(harnessVersion(join(import.meta.dir, ".."))).toMatch(/^[0-9a-f]{7,}(-dirty)?$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("turn telemetry: the daemon's turns", () => {
  async function setup(models = createModels(), registry = createRegistry()) {
    const store = await AgentStore.open({ storage: new MemoryStorage() }, { models, registry }, ctx);
    const captured: Array<{ event: string; properties: Record<string, unknown> }> = [];
    const telemetry = new TurnTelemetry({ capture: (event, properties) => captured.push({ event, properties }), harnessVersion: "v1", isSubagent: () => false, context: ctx });
    telemetry.attach("agent-local-a", store);
    return { store, captured };
  }
  const until = async (check: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  };

  test("a run that calls a failing tool and answers is one turn_finished, with the turn id the app hears", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    registry.install(defineExtension({ name: "t", tools: [defineTool({ name: "boom", description: "fails", parameters: { type: "object", properties: {} } as never, execute: async () => { throw new Error("no"); } })] }));
    const { store, captured } = await setup(models, registry);
    try {
      faux.setResponses([fauxAssistantMessage(fauxToolCall("boom", {}), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
      const chat = await store.createChat("local-conv-1", { agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } } }, ctx);
      const stream = await watchEvents(store.harness, chat.id, ctx);
      const converter = new ChatEventConverter("agent-local-a");
      const events: ChatEvent[] = [];
      stream.start(async (batch) => void events.push(...batch.flatMap((ev) => converter.convert(ev))));
      await (await chat.submit({ type: "input", content: "hello", requestId: "send-1" }, ctx)).wait(ctx);
      await until(() => captured.length > 0 && events.some((e) => e.kind === "turn_end"));
      await stream.stop();
      expect(captured.map((c) => c.event)).toEqual(["turn_finished"]);
      const p = captured[0].properties;
      expect(p).toMatchObject({ chat: "local-conv-1", agent: "agent-local-a", desk: "local-conv-1", model: `${faux.provider.id}/${faux.getModel().id}`, harness_version: "v1", origin: "message", responses: 2, tool_calls: 1, tool_failures: 1, error: false, error_code: null, stop_reason: "stop" });
      for (const key of ["ttft_ms", "total_ms", "model_ms", "tool_ms", "overhead_ms"]) expect(typeof p[key]).toBe("number");
      expect(p.total_ms as number).toBeGreaterThanOrEqual(p.ttft_ms as number);
      // The app's chat events name the same turn as it starts and as it ends.
      expect(events.find((e) => e.kind === "loop" && e.state === "running")).toMatchObject({ turnId: p.turn_id });
      expect(events.find((e) => e.kind === "turn_end")).toMatchObject({ turnId: p.turn_id });
    } finally {
      await store.close(ctx);
    }
  });

  test("a message the agent could not take up is a turn that failed at once", async () => {
    const { store, captured } = await setup();
    try {
      const chat = await store.createChat("local-conv-2", { agent: { model: { provider: "nowhere", modelId: "nothing" } } }, ctx);
      await (await chat.submit({ type: "input", content: "hello" }, ctx)).wait(ctx);
      await until(() => captured.length > 0);
      expect(captured).toHaveLength(1);
      expect(captured[0].properties).toMatchObject({ chat: "local-conv-2", model: "nowhere/nothing", error: true, error_code: "no_model", responses: 0, ttft_ms: null, tool_calls: 0 });
      expect(captured[0].properties.turn_id).toMatch(/^agent-local-a:/);
    } finally {
      await store.close(ctx);
    }
  });
});
