import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { DaemonChats } from "../daemon/chat-backend.ts";
import { Approvals } from "../daemon/approvals.ts";
import { KeychainCredentials, memorySecrets } from "../daemon/credentials.ts";
import { Providers } from "../daemon/providers.ts";
import { AgentStore } from "../daemon/kernel/index.ts";
import { StoreManager } from "../daemon/kernel/stores.ts";
import { ModRegistry } from "../daemon/mods/registry.ts";
import { AcpChats, type AcpChatsDeps } from "../daemon/acp/chats.ts";
import { acpHandle, CLAUDE_CODE, commandFound, readAcpAgents, writeAcpAgents, type AcpAgentConfig } from "../daemon/acp/agents.ts";
import { entrySteps } from "../core/attention/pi-steps.ts";
import type { ChatEvent } from "../core/attention/model.ts";
import { must } from "./fixtures/must.ts";

const ctx = BACKGROUND_CONTEXT;
const SCRIPT = join(import.meta.dirname, "fixtures", "fake-acp.mjs");
const FAKE: AcpAgentConfig = { id: "fake", name: "Fake", command: process.execPath, args: [SCRIPT] };

const until = async (check: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  if (!check()) throw new Error("timed out waiting");
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A daemon with ACP chats on the fake agent; `restart` makes a new one over the same stores, as after a restart. */
function setup(
  opts: {
    systemPrompt?: (agentId: string, withTools: boolean) => string | null;
    env?: Record<string, string>;
    mcpServers?: AcpChatsDeps["mcpServers"];
    allowedTools?: AcpChatsDeps["allowedTools"];
    openUrl?: AcpChatsDeps["openUrl"];
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "loki-acp-"));
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const mods = new ModRegistry(() => {});
  const stores = new StoreManager(
    join(dir, "stores"),
    { models, registry: mods.registry },
    ctx,
    () => {},
    () => AgentStore.open({ storage: new MemoryStorage() }, { models, registry: mods.registry }, ctx),
  );
  const pushed: Array<{ conversationId: string; events: ChatEvent[] }> = [];
  const captured: Array<{ event: string; properties: Record<string, unknown> }> = [];
  const make = () => {
    const approvals = new Approvals();
    const acp = new AcpChats({
      stores,
      approvals,
      context: ctx,
      agents: () => [{ ...FAKE, ...(opts.env ? { env: opts.env } : {}) }],
      ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
      ...(opts.mcpServers ? { mcpServers: opts.mcpServers } : {}),
      ...(opts.allowedTools ? { allowedTools: opts.allowedTools } : {}),
      ...(opts.openUrl ? { openUrl: opts.openUrl } : {}),
      homeDir: dir,
      cacheFile: join(dir, "state", "acp-offered.json"),
      capture: (event, properties) => captured.push({ event, properties }),
    });
    const chats = new DaemonChats({
      stores,
      mods,
      approvals,
      providers: new Providers(models, new KeychainCredentials(memorySecrets())),
      models,
      acp,
      backendDir: join(dir, "backend"),
      context: ctx,
    });
    chats.attach((_agentId, conversationId, events) => pushed.push({ conversationId, events }));
    return { approvals, acp, chats };
  };
  let daemon = make();
  cleanups.push(async () => {
    await daemon.acp.close();
    await stores.closeAll();
    rmSync(dir, { recursive: true, force: true });
  });
  const events = () => pushed.flatMap((p) => p.events);
  const turnsEnded = () => events().filter((e) => e.kind === "turn_end").length;
  const words = () =>
    events()
      .flatMap((e) => (e.kind === "step" && e.step.kind === "assistant" && !e.step.chunk ? [e.step.text] : []))
      .join(" | ");
  const errors = () => events().flatMap((e) => (e.kind === "error" ? [e.message] : []));
  /** A new ACP chat on the fake agent. */
  const chat = async () => {
    const { conversationId } = await daemon.chats.create("ada", null, null);
    await daemon.chats.model({ agent_id: "ada", conversation_id: conversationId, handle: "acp:fake/default", reasoning_effort: null });
    return conversationId;
  };
  /** Send and wait for the turn to end. */
  const say = async (conversationId: string, text: string) => {
    const before = turnsEnded();
    await daemon.chats.send({ agent_id: "ada", conversation_id: conversationId, text, images: [], context: null, send_id: null });
    await until(() => turnsEnded() > before);
  };
  const stored = async (conversationId: string) => {
    const store = await stores.get("ada");
    const conversation = must(await store.chat(conversationId, ctx));
    return { store, conversation, entries: await store.entries(conversation, ctx) };
  };
  const restart = async () => {
    await daemon.acp.close();
    daemon = make();
  };
  return {
    get chats() {
      return daemon.chats;
    },
    get approvals() {
      return daemon.approvals;
    },
    get acp() {
      return daemon.acp;
    },
    pushed,
    captured,
    events,
    words,
    errors,
    chat,
    say,
    stored,
    restart,
  };
}

describe("ACP agents (plan 020)", () => {
  test("the agents: Claude Code built in, others from the file, a bad one skipped; ACP handles named", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-acp-agents-"));
    try {
      expect(readAcpAgents(join(dir, "none.json"))).toEqual([CLAUDE_CODE]);
      expect(acpHandle("acp:claude-code/sonnet")).toEqual({ agent: "claude-code", model: "sonnet" });
      expect(acpHandle("anthropic/claude-sonnet")).toBeNull();
      expect(commandFound(process.execPath)).toBe(true);
      expect(commandFound(join(dir, "nothing-here"))).toBe(false);
      expect(commandFound("node-that-is-not-there", { PATH: dir })).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a turn streams, is written to the chat's own store, and its usage is counted under the agent's model", async () => {
    const s = setup();
    const id = await s.chat();
    await s.say(id, "hello");
    // The engine's own updates (device) are the next test's.
    const kinds = s
      .events()
      .filter((e) => e.kind !== "device")
      .map((e) => (e.kind === "step" ? `step:${e.step.kind}${e.step.kind === "assistant" && e.step.chunk ? "-chunk" : ""}` : e.kind));
    expect(kinds).toEqual(["loop", "step:user", "step:assistant-chunk", "step:assistant-chunk", "step:assistant", "settle", "loop", "turn_end"]);
    expect(s.words()).toBe("Hi there");
    const { store, conversation, entries } = await s.stored(id);
    expect(entries.flatMap((e) => entrySteps(e)).map((st) => st.kind)).toEqual(["user", "assistant"]);
    expect(entries.flatMap((e) => entrySteps(e))[1]).toMatchObject({ text: "Hi there" });
    // The agent reports its running total of dollars; each turn counts only what it added.
    await s.say(id, "hello");
    const usage = must(await store.usage(conversation.id, ctx));
    expect(usage.models["acp:fake/fake-sonnet"]).toMatchObject({ input: 200, output: 40, cacheRead: 100, cacheWrite: 20, totalTokens: 360 });
    expect(usage.models["acp:fake/fake-sonnet"].cost.total).toBeCloseTo(0.5);
    expect(await s.chats.busy("ada", id)).toBe(false);
  });

  test("a permission request is a loki approval card; always allow picks the agent's own, and stays off loki's list", async () => {
    const s = setup();
    const id = await s.chat();
    await s.chats.send({ agent_id: "ada", conversation_id: id, text: "edit", images: [], context: null, send_id: null });
    await until(() => s.events().some((e) => e.kind === "approval"));
    const approval = must(s.events().find((e): e is Extract<ChatEvent, { kind: "approval" }> => e.kind === "approval"));
    expect(approval).toMatchObject({ tool_name: "Edit notes.txt", input: { path: "notes.txt" } });
    expect(await s.chats.busy("ada", id)).toBe(true);
    expect((await s.chats.open("ada", id)).loop).toBe("approval");
    expect(await s.chats.approve({ agent_id: "ada", conversation_id: id, approval_id: approval.request_id, allow: true, always: true, message: null })).toBe(
      true,
    );
    await until(() => s.events().some((e) => e.kind === "turn_end"));
    expect(s.words()).toContain("edited (always)");
    expect(s.approvals.always()).toEqual([]);
    const steps = (await s.stored(id)).entries.flatMap((e) => entrySteps(e));
    expect(steps.map((st) => st.kind)).toEqual(["user", "assistant", "call", "result", "assistant"]);
    expect(steps[2]).toMatchObject({ name: "Edit notes.txt", args: { path: "notes.txt" } });
    expect(JSON.stringify(steps[3])).toContain("+new");
  });

  test("a denied call fails, and Stop withdraws the card and cancels the turn", async () => {
    const s = setup();
    const id = await s.chat();
    await s.chats.send({ agent_id: "ada", conversation_id: id, text: "edit", images: [], context: null, send_id: null });
    await until(() => s.events().some((e) => e.kind === "approval"));
    const first = must(s.events().find((e): e is Extract<ChatEvent, { kind: "approval" }> => e.kind === "approval"));
    s.chats.approve({ agent_id: "ada", conversation_id: id, approval_id: first.request_id, allow: false, always: false, message: null }).catch(() => {});
    await until(() => s.events().filter((e) => e.kind === "turn_end").length === 1);
    expect(s.words()).toContain("not edited");
    expect(s.events().some((e) => e.kind === "step" && e.step.kind === "result" && e.step.failed)).toBe(true);

    await s.chats.send({ agent_id: "ada", conversation_id: id, text: "edit", images: [], context: null, send_id: null });
    await until(() => s.events().filter((e) => e.kind === "approval").length === 2);
    await s.chats.abort("ada", id);
    await until(() => s.events().filter((e) => e.kind === "turn_end").length === 2);
    expect(s.words()).toContain("cancelled");
    expect(s.approvals.waitingIn("ada", id)).toEqual([]);

    await s.chats.send({ agent_id: "ada", conversation_id: id, text: "wait", images: [], context: null, send_id: null });
    await until(() => s.events().some((e) => e.kind === "step" && e.step.kind === "assistant" && e.step.text === "working"));
    expect((await s.chats.open("ada", id)).streaming).toMatchObject({ text: "working" });
    await s.chats.abort("ada", id);
    await until(() => s.events().filter((e) => e.kind === "turn_end").length === 3);
  });

  test("each turn is one turn_finished line: the agent's tokens and cost, its calls, and how it ended", async () => {
    const s = setup();
    const id = await s.chat();
    const turns = () => s.captured.filter((c) => c.event === "turn_finished").map((c) => c.properties);
    await s.say(id, "hello");
    expect(turns()).toHaveLength(1);
    expect(turns()[0]).toMatchObject({
      desk: id,
      chat: id,
      agent: "ada",
      model: "acp:fake/fake-sonnet",
      harness_version: "acp:fake",
      origin: "message",
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 50,
      cache_write_tokens: 10,
      cache_share: 0.313,
      responses: 1,
      tool_calls: 0,
      model_ms: null,
      tool_ms: null,
      overhead_ms: null,
      stop_reason: "end_turn",
      error: false,
      error_code: null,
    });
    expect(turns()[0].cost).toBeGreaterThan(0);
    expect(typeof turns()[0].ttft_ms).toBe("number");
    expect(turns()[0].total_ms).toBeGreaterThanOrEqual(turns()[0].ttft_ms as number);
    // The app's turn id, so client events join it.
    expect(turns()[0].turn_id).toBe(s.events().find((e) => e.kind === "turn_end")?.turn_id);

    await s.say(id, "write");
    expect(turns()[1]).toMatchObject({ tool_calls: 1, tool_failures: 0 });

    await s.chats.send({ agent_id: "ada", conversation_id: id, text: "wait", images: [], context: null, send_id: null });
    await until(() => s.events().some((e) => e.kind === "step" && e.step.kind === "assistant" && e.step.text === "working"));
    await s.chats.abort("ada", id);
    await until(() => turns().length === 3);
    expect(turns()[2]).toMatchObject({ stop_reason: "cancelled", error: true, error_code: "aborted" });

    await s.say(id, "crash");
    expect(turns()[3]).toMatchObject({ stop_reason: null, error: true, error_code: "agent_error" });
    // It said something before it died.
    expect(typeof turns()[3].ttft_ms).toBe("number");
  });

  test("a message sent twice runs once, and one sent mid-turn waits its turn", async () => {
    const s = setup();
    const id = await s.chat();
    const send = (text: string, sendId: string) => s.chats.send({ agent_id: "ada", conversation_id: id, text, images: [], context: null, send_id: sendId });
    await send("mode?", "a");
    await send("mode?", "a");
    await send("hello", "b");
    await until(() => s.events().filter((e) => e.kind === "turn_end").length === 2);
    expect(s.words()).toBe("mode default, model default | Hi there");
  });

  test("the agent's process dying fails the turn with its stderr; the next message starts it again and loads the session", async () => {
    const s = setup();
    const id = await s.chat();
    await s.say(id, "hello");
    await s.say(id, "crash");
    expect(s.errors().join("\n")).toMatch(/fake-acp: ready/);
    await s.say(id, "mode?");
    expect(s.words()).toContain("mode default");
    // The agent replays a loaded session's history; loki has it already.
    expect(s.words()).not.toContain("replayed");
  });

  test("after a restart the chat loads its session; one the agent lost starts afresh, and says so", async () => {
    const s = setup();
    const id = await s.chat();
    await s.say(id, "hello");
    const { store } = await s.stored(id);
    const sessionId = must((await store.chats(ctx)).find((c) => c.id === id)?.engine?.session_id);
    await s.restart();
    await s.say(id, "mode?");
    expect(s.words()).not.toContain("replayed");
    expect((await store.chats(ctx)).find((c) => c.id === id)?.engine?.session_id).toBe(sessionId);
    expect(s.errors()).toEqual([]);

    await store.updateChat(id, { engine: { kind: "acp", agent: "fake", model: "default", session_id: "gone" } }, ctx);
    await s.restart();
    await s.say(id, "mode?");
    expect(s.errors().join("\n")).toMatch(/starts afresh/);
    expect((await store.chats(ctx)).find((c) => c.id === id)?.engine?.session_id).not.toBe("gone");
  });

  test("the engine is chosen before the first message and fixed after it; the model and mode reach the agent", async () => {
    const s = setup();
    const { conversationId: id } = await s.chats.create("ada", null, null);
    const model = (handle: string) => s.chats.model({ agent_id: "ada", conversation_id: id, handle, reasoning_effort: null });
    await model("acp:fake/default");
    await model("faux/faux-1");
    const { store } = await s.stored(id);
    expect((await store.chats(ctx)).find((c) => c.id === id)?.engine).toBeNull();
    await model("acp:fake/sonnet");
    await s.chats.open("ada", id, "plan");
    await s.say(id, "mode?");
    expect(s.words()).toBe("mode plan, model sonnet");
    await expect(model("faux/faux-1")).rejects.toThrow(/start a new chat/);
    await expect(model("acp:nobody/x")).rejects.toThrow(/no ACP agent/);
    await expect(s.chats.folder("ada", id, tmpdir())).rejects.toThrow(/folder it started in/);
    // A command other than loki's passes goes to the agent as typed.
    expect(await s.chats.command({ agent_id: "ada", conversation_id: id, command: "mode?", args: null })).toMatchObject({ success: true });
  });

  test("the picker offers the agent before it has run, then the models it offered, kept for the next start", async () => {
    const s = setup();
    expect(s.acp.models()).toEqual([
      { id: "acp:fake/default", handle: "acp:fake/default", label: "Fake", description: "runs on Fake, signed in as you", is_featured: true },
    ]);
    const id = await s.chat();
    await s.say(id, "hello");
    // One handle per model; a model with effort levels is one entry per level (plan 021).
    const handles = () => [...new Map(s.acp.models().map((m) => [m.handle, [m.handle, m.label]])).values()];
    expect(handles()).toEqual([
      ["acp:fake/default", "Fake"],
      ["acp:fake/sonnet", "Fake · Sonnet"],
    ]);
    expect((await s.chats.models()).map((m) => m.handle)).toContain("acp:fake/sonnet");
    await s.restart();
    expect(handles()).toEqual([
      ["acp:fake/default", "Fake"],
      ["acp:fake/sonnet", "Fake · Sonnet"],
    ]);
  });

  test("each model's effort levels are remembered as it is used, in loki's words, and kept for the next start (plan 021)", async () => {
    const s = setup();
    const efforts = () => s.acp.models().map((m) => [m.handle, m.reasoning_effort ?? null]);
    const id = await s.chat();
    await s.say(id, "hello");
    expect(efforts()).toEqual([
      ["acp:fake/default", "low"],
      ["acp:fake/default", "medium"],
      ["acp:fake/default", "high"],
      ["acp:fake/sonnet", null],
    ]);
    await s.chats.model({ agent_id: "ada", conversation_id: id, handle: "acp:fake/sonnet", reasoning_effort: null });
    // Sonnet's "ultra" has no word in loki, so it is left out.
    expect(efforts().slice(3)).toEqual([
      ["acp:fake/sonnet", "low"],
      ["acp:fake/sonnet", "high"],
      ["acp:fake/sonnet", "max"],
    ]);
    expect(new Set(s.acp.models().map((m) => m.id)).size).toBe(6);
    await s.restart();
    expect(efforts()).toHaveLength(6);
  });

  test("picking the agent opens its session before anything is said, so its models and effort levels are known at once", async () => {
    const s = setup();
    const { conversationId: id } = await s.chats.create("ada", null, null);
    await s.chats.model({ agent_id: "ada", conversation_id: id, handle: "acp:fake/default", reasoning_effort: null });
    await until(() => s.acp.models().some((m) => m.reasoning_effort === "medium"));
    expect([...new Set(s.acp.models().map((m) => m.handle))]).toEqual(["acp:fake/default", "acp:fake/sonnet"]);
    // A model picked while it is open reaches the session; the first message runs on it.
    await s.chats.model({ agent_id: "ada", conversation_id: id, handle: "acp:fake/sonnet", reasoning_effort: "max" });
    await s.say(id, "effort?");
    expect(s.words()).toBe("model sonnet, effort max");
    expect(s.events().filter((e) => e.kind === "step" && e.step.kind === "user")).toHaveLength(1);
  });

  test("a chat that leaves the agent while its session opens stays where it went", async () => {
    const s = setup();
    const { conversationId: id } = await s.chats.create("ada", null, null);
    await s.chats.model({ agent_id: "ada", conversation_id: id, handle: "acp:fake/default", reasoning_effort: null });
    await s.chats.model({ agent_id: "ada", conversation_id: id, handle: "faux/faux-1", reasoning_effort: null });
    await until(() => s.acp.models().some((m) => m.reasoning_effort === "medium"));
    const { store } = await s.stored(id);
    expect((await store.chats(ctx)).find((c) => c.id === id)?.engine).toBeNull();
  });

  test("the chosen effort reaches the agent's open session, and a new session starts on it", async () => {
    const s = setup();
    const id = await s.chat();
    await s.say(id, "effort?");
    await s.chats.model({ agent_id: "ada", conversation_id: id, handle: "acp:fake/sonnet", reasoning_effort: "max" });
    await s.say(id, "effort?");
    const { store } = await s.stored(id);
    expect((await store.chats(ctx)).find((c) => c.id === id)?.engine).toMatchObject({ model: "sonnet", effort: "max" });
    // A level the model does not offer leaves the agent's own.
    await s.chats.model({ agent_id: "ada", conversation_id: id, handle: "acp:fake/sonnet", reasoning_effort: "medium" });
    await s.say(id, "effort?");
    await s.chats.model({ agent_id: "ada", conversation_id: id, handle: "acp:fake/sonnet", reasoning_effort: "high" });
    await s.restart();
    await s.say(id, "effort?");
    expect(s.words()).toBe("model default, effort default | model sonnet, effort max | model sonnet, effort max | model sonnet, effort high");
  });

  test("the chat's engine reaches the app with the agent's modes and commands, and leaves when it goes back to loki", async () => {
    const s = setup();
    const { conversationId: id } = await s.chats.create("ada", null, null);
    await s.chats.model({ agent_id: "ada", conversation_id: id, handle: "acp:fake/default", reasoning_effort: null });
    const engines = () => s.events().flatMap((e) => (e.kind === "device" && e.engine !== undefined ? [e.engine] : []));
    expect(engines().at(-1)).toMatchObject({ agent: "fake", name: "Fake", model: "default", modes: [], commands: [] });
    await s.chats.model({ agent_id: "ada", conversation_id: id, handle: "faux/faux-1", reasoning_effort: null });
    expect(engines().at(-1)).toBeNull();
    await s.chats.model({ agent_id: "ada", conversation_id: id, handle: "acp:fake/default", reasoning_effort: null });
    await s.say(id, "hello");
    await until(() => (engines().at(-1)?.commands.length ?? 0) > 0);
    const view = {
      agent: "fake",
      name: "Fake",
      model: "default",
      modes: [
        { id: "default", name: "Default", description: null },
        { id: "plan", name: "Plan", description: null },
      ],
      commands: [{ name: "review", description: "review the changes", hint: "[branch]" }],
    };
    expect(engines().at(-1)).toEqual(view);
    expect((await s.chats.open("ada", id)).engine).toEqual(view);
  });

  test("a chat opened on loki's engine and then moved to an agent shows each message once", async () => {
    const s = setup();
    const { conversationId: id } = await s.chats.create("ada", null, null);
    // Opened first, as the app does: loki follows the chat through pi-durable from here on.
    await s.chats.open("ada", id);
    await s.chats.model({ agent_id: "ada", conversation_id: id, handle: "acp:fake/default", reasoning_effort: null });
    await s.say(id, "hello");
    const steps = s.events().flatMap((e) => (e.kind === "step" && !(e.step.kind === "assistant" && e.step.chunk) ? [e.step.kind] : []));
    expect(steps).toEqual(["user", "assistant"]);
  });

  test("a call shows once it has arguments, and a file's last newline is not one more line of its diff", async () => {
    const s = setup();
    const id = await s.chat();
    await s.say(id, "write");
    const calls = s.events().flatMap((e) => (e.kind === "step" && e.step.kind === "call" ? [e.step] : []));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.name === "Write a.txt")).toBe(true);
    const result = s.events().find((e) => e.kind === "step" && e.step.kind === "result");
    // As every result leaves the daemon (plan 035): its text, not its parts.
    expect(result).toMatchObject({ step: { output: "--- a.txt\n+++ a.txt\n+a" } });
  });

  test("Settings › Engines: how each agent stands, and adding, changing, trying and removing one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-acp-engines-"));
    const file = join(dir, "state", "acp.json");
    // Claude Code started the person's way, on the fake agent, so nothing here depends on npx being installed.
    writeAcpAgents(file, [{ ...FAKE, id: "claude-code", name: "Claude Code" }]);
    const stores = new StoreManager(
      join(dir, "stores"),
      { models: createModels(), registry: new ModRegistry(() => {}).registry },
      ctx,
      () => {},
      () => AgentStore.open({ storage: new MemoryStorage() }, { models: createModels(), registry: new ModRegistry(() => {}).registry }, ctx),
    );
    const acp = new AcpChats({ stores, approvals: new Approvals(), context: ctx, agents: () => readAcpAgents(file), homeDir: dir, configFile: file });
    cleanups.push(async () => {
      await acp.close();
      await stores.closeAll();
      rmSync(dir, { recursive: true, force: true });
    });
    const one = (id: string) => must(acp.engines().engines.find((e) => e.id === id));
    expect(acp.engines().config_path).toBe(file);
    expect(one("claude-code")).toMatchObject({ builtin: true, changed: true, status: "unknown", command: process.execPath });

    expect((await acp.checkEngine("claude-code")).engines[0]).toMatchObject({ status: "started" });

    await acp.setEngine({ id: "gone", name: "Gone", command: join(dir, "no-such-agent"), args: [] });
    expect(one("gone")).toMatchObject({ builtin: false, status: "not_found" });
    expect(readAcpAgents(file).map((a) => a.id)).toEqual(["claude-code", "gone"]);
    await acp.setEngine({ id: "gone", name: "Gone", command: process.execPath, args: [join(dir, "no-such-script.mjs")] });
    expect((await acp.checkEngine("gone")).engines.find((e) => e.id === "gone")).toMatchObject({ status: "failed" });

    await acp.removeEngine("gone");
    await acp.removeEngine("claude-code");
    expect(readAcpAgents(file)).toEqual([CLAUDE_CODE]);
    expect(one("claude-code")).toMatchObject({ builtin: true, changed: false });
  });

  test("a turn that fails for want of signing in marks the agent as needing it; one that works marks it ready", async () => {
    const s = setup();
    const id = await s.chat();
    await s.say(id, "auth");
    expect(s.errors().join("\n")).toMatch(/Authentication required/);
    expect(s.acp.engines().engines[0]).toMatchObject({ status: "signed_out", detail: "sign in to Fake, then send again" });
    await s.say(id, "hello");
    expect(s.acp.engines().engines[0]).toMatchObject({ status: "ready", detail: null });
  });

  test("the agent's persona and memory go in its system prompt, or ahead of the first message when it takes none", async () => {
    const withPrompt = setup({ systemPrompt: () => "You are Ada." });
    const a = await withPrompt.chat();
    await withPrompt.say(a, "prompt?");
    expect(withPrompt.words()).toBe("system: You are Ada. | first: prompt?");

    const without = setup({ systemPrompt: () => "You are Ada.", env: { FAKE_ACP_NO_SYSTEM_PROMPT: "1" } });
    const b = await without.chat();
    await without.say(b, "prompt?");
    expect(without.words()).toMatch(/^system: none \| first: <loki-agent>\nYou are Ada.\n<\/loki-agent>/);
  });

  test("a session opens with loki's tools and the agent's MCP servers, and runs the read-only ones without asking (plan 044)", async () => {
    const asked: string[] = [];
    const servers: AcpChatsDeps["mcpServers"] = (agentId, conversationId) => {
      asked.push(`${agentId} ${conversationId}`);
      return Promise.resolve([
        { type: "http", name: "loki", url: "http://127.0.0.1:1/mcp/loki", headers: [] },
        { type: "http", name: "notes", url: "http://127.0.0.1:1/mcp/notes", headers: [] },
      ]);
    };
    const prompts: boolean[] = [];
    const systemPrompt = (_agentId: string, withTools: boolean) => {
      prompts.push(withTools);
      return null;
    };
    const s = setup({ mcpServers: servers, allowedTools: () => ["mcp__loki__memory_read"], systemPrompt });
    const id = await s.chat();
    await s.say(id, "mcp?");
    expect(s.words()).toBe("mcp: loki http://127.0.0.1:1/mcp/loki, notes http://127.0.0.1:1/mcp/notes | allowed: mcp__loki__memory_read");
    expect(asked).toContain(`ada ${id}`);
    expect(prompts.at(-1)).toBe(true);

    // An agent that takes no MCP server over HTTP gets none, and its prompt keeps the memory read-only.
    const plain = setup({ mcpServers: servers, systemPrompt, env: { FAKE_ACP_NO_HTTP_MCP: "1" } });
    const other = await plain.chat();
    await plain.say(other, "mcp?");
    expect(plain.words()).toBe("mcp: none | allowed: none");
    expect(prompts.at(-1)).toBe(false);
  });

  test("the agent's sign-in page is a card first, and opens in this Mac's browser once allowed (plan 044)", async () => {
    const opened: string[] = [];
    const s = setup({ openUrl: (url) => opened.push(url) });
    const id = await s.chat();
    await s.chats.send({ agent_id: "ada", conversation_id: id, text: "signin", images: [], context: null, send_id: null });
    await until(() => s.events().some((e) => e.kind === "approval"));
    const card = must(s.events().find((e): e is Extract<ChatEvent, { kind: "approval" }> => e.kind === "approval"));
    expect(card).toMatchObject({ tool_name: "Authenticate with MCP server notion", input: { url: "https://signin.example.com/authorize?state=1" } });
    expect(opened).toEqual([]);
    await s.chats.approve({ agent_id: "ada", conversation_id: id, approval_id: card.request_id, allow: true, always: false, message: null });
    await until(() => s.events().some((e) => e.kind === "turn_end"));
    expect(opened).toEqual(["https://signin.example.com/authorize?state=1"]);
    expect(s.words()).toBe("sign-in accept");

    // Denied: nothing opens, and the agent hears it declined.
    const other = await s.chat();
    await s.chats.send({ agent_id: "ada", conversation_id: other, text: "signin", images: [], context: null, send_id: null });
    await until(() => s.events().filter((e) => e.kind === "approval").length === 2);
    const second = must(s.events().filter((e): e is Extract<ChatEvent, { kind: "approval" }> => e.kind === "approval")[1]);
    await s.chats.approve({ agent_id: "ada", conversation_id: other, approval_id: second.request_id, allow: false, always: false, message: null });
    await until(() => s.events().filter((e) => e.kind === "turn_end").length === 2);
    expect(opened).toHaveLength(1);
    expect(s.words()).toContain("sign-in decline");
  });
});
