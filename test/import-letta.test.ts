import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { importFromLetta, lettaCredentials, runningLetta, type ImportPaths } from "../daemon/import/letta.ts";
import { KeychainCredentials, memorySecrets } from "../daemon/credentials.ts";
import { AgentStore } from "../daemon/kernel/index.ts";
import { StoreManager } from "../daemon/kernel/stores.ts";
import { backendName, conversationDirName } from "../core/desk-core.ts";
import { entrySteps } from "../core/attention/pi-steps.ts";
import { foldSteps } from "../core/attention/thread.ts";
import { assistantLine, compactionLine, headerLine, logText, userLine } from "./fixtures/letta-log.ts";

const ctx = BACKGROUND_CONTEXT;
const A = "agent-local-aaaa";
const B = "agent-local-bbbb";
const HELPER = "agent-local-helper";
let dir: string;
let letta: string;

function put(file: string, value: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

function agent(id: string, name: string, tags: string[] = ["origin:letta-code"]) {
  put(join(letta, "lc-local-backend", "agents", `${backendName(id)}.json`), { id, name, description: null, system: "", tags, model: "openrouter/some-model", model_settings: {}, hidden: false });
  put(join(letta, "lc-local-backend", "memfs", id, "memory", "system", "persona.md"), `I am ${name}`);
}

function conversation(agentId: string, id: string, record: Record<string, unknown>, log: string) {
  const base = join(letta, "lc-local-backend", "conversations", conversationDirName(id, agentId));
  put(join(base, "conversation.json"), { id, agent_id: agentId, archived: false, created_at: "2026-10-01T10:00:00.000Z", summary: null, ...record });
  put(join(base, "messages.jsonl"), log);
}

// Lines: 0 header, 1 u1, 2 a1, 3 u2, 4 a2, 5 compaction (keeps u2), 6 u3, 7 a3.
const LONG = logText([
  headerLine("/from/log"),
  userLine("u1", null, "2026-10-01T10:00:01.000Z", "first"),
  assistantLine("a1", "u1", "2026-10-01T10:00:02.000Z", "one"),
  userLine("u2", "a1", "2026-10-01T10:00:03.000Z", "second"),
  assistantLine("a2", "u2", "2026-10-01T10:00:04.000Z", "two"),
  compactionLine("c1", "a2", "2026-10-01T10:00:05.000Z", "they said first and second", "u2"),
  userLine("u3", "c1", "2026-10-01T10:00:06.000Z", "third"),
  assistantLine("a3", "u3", "2026-10-01T10:00:07.000Z", "three"),
]);

function paths(): ImportPaths {
  return {
    letta,
    backendDir: join(dir, "loki", "backend"),
    doneFile: join(dir, "loki", "state", "letta-import.json"),
    schedulesFile: join(dir, "loki", "state", "crons.json"),
    pinsFile: join(dir, "loki", "state", "pins.json"),
    recallWorkerFile: join(dir, "loki", "recall", "worker.json"),
  };
}

function setup() {
  const models = createModels();
  const registry = createRegistry();
  const stores = new StoreManager(join(dir, "stores"), { models, registry }, ctx, () => {}, () => AgentStore.open({ storage: new MemoryStorage() }, { models, registry }, ctx));
  const secrets = memorySecrets();
  const credentials = new KeychainCredentials(secrets);
  const run = (running: () => string | null = () => null) => importFromLetta({ paths: paths(), stores, credentials, knownProviders: new Set(["openrouter", "openai-codex", "anthropic"]), context: ctx, running });
  return { stores, credentials, run };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loki-import-"));
  letta = join(dir, "letta");
  agent(A, "Ada");
  agent(B, "Bo");
  agent(HELPER, "helper", ["origin:letta-code", "role:subagent"]);
  mkdirSync(join(letta, "lc-local-backend", "memfs", "agent-local-orphan", "memory"), { recursive: true }); // no record
  conversation(A, "default", {}, logText([headerLine(), userLine("x1", null, "2026-10-01T09:00:00.000Z", "hi"), assistantLine("x2", "x1", "2026-10-01T09:00:01.000Z", "hello")]));
  conversation(A, "local-conv-long", { summary: "Plans", archived: true }, LONG);
  conversation(B, "default", {}, logText([headerLine()]));
  conversation(HELPER, "default", {}, logText([headerLine(), userLine("h1", null, "2026-10-01T09:00:00.000Z", "task")]));
  put(join(letta, "remote-settings.json"), { permissionModeMap: { "conversation:local-conv-long": { mode: "acceptEdits" } }, cwdMap: {} });
  put(join(letta, "desktop-cwd-map.json"), { version: 1, cwdMap: { [`agent:${A}::conversation:default`]: "/work/ada" } });
  put(join(letta, "lc-local-backend", "providers", "auth.json"), {
    version: 1,
    providers: {
      openrouter: { id: "openrouter", provider_type: "openrouter", auth: { type: "api", key: "sk-or-test" } },
      "chatgpt-plus-pro": { id: "chatgpt-plus-pro", provider_type: "chatgpt_oauth", auth: { type: "oauth", access: "acc", refresh: "ref", expires: 123, accountId: "acct" } },
      "claude-pro-max": { id: "claude-pro-max", provider_type: "anthropic", auth: { type: "oauth", access: "a", refresh: "r", expires: 1 } },
    },
  });
  put(join(letta, "crons.json"), {
    version: 1,
    tasks: [
      { id: "t1", name: "standup", description: null, agent_id: A, conversation_id: "default", cron: "0 9 * * *", timezone: "UTC", recurring: true, status: "active", prompt: "post it", created_at: "2026-10-01T00:00:00Z", fire_count: 3 },
      { id: "t2", name: "old", agent_id: A, conversation_id: "default", cron: "0 9 1 1 *", timezone: "UTC", recurring: false, status: "fired", prompt: "done", created_at: "2026-01-01T00:00:00Z" },
      { id: "t3", name: "helper's", agent_id: HELPER, conversation_id: "default", cron: "* * * * *", timezone: "UTC", recurring: true, status: "active", prompt: "x" },
    ],
  });
  put(join(letta, "pinned-conversations.json"), { version: 1, agents: { [A]: ["local-conv-long"] } });
  // Learn had read the long chat up to line 5 (through the compaction) and its leads up to line 3.
  put(paths().recallWorkerFile, { cursors: { [`${A}/local-conv-long`]: 6 }, leadCursors: { [`${A}/local-conv-long`]: 3 }, tickMinutes: 10 });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function rows(stores: StoreManager, agentId: string, chatId: string) {
  const store = await stores.get(agentId);
  const chat = (await store.chat(chatId, ctx))!;
  return { store, chat, entries: await store.entries(chat, ctx) };
}

describe("importing from Letta", () => {
  test("only the person's agents come over, with their memory, records and chats under their Letta ids", async () => {
    const { stores, run } = setup();
    try {
      const report = await run();
      expect(report.agents.sort()).toEqual(["Ada", "Bo"]);
      expect(report.chats).toBe(3);
      const p = paths();
      expect(readFileSync(join(p.backendDir, "memfs", A, "memory", "system", "persona.md"), "utf8")).toBe("I am Ada");
      expect(existsSync(join(p.backendDir, "agents", `${backendName(A)}.json`))).toBe(true);
      expect(existsSync(join(p.backendDir, "memfs", HELPER))).toBe(false);
      const ada = await rows(stores, A, "default");
      expect(foldSteps(ada.entries.flatMap(entrySteps)).map((r) => r.text)).toEqual(["hi", "hello"]);
      expect(((await ada.store.agentSettings(ada.chat.id, ctx)) as { cwd?: string } | undefined)?.cwd).toBe("/work/ada"); // the desktop's folder wins over the log's
      const long = await rows(stores, A, "local-conv-long");
      const info = await long.store.chatInfo(long.chat.id, ctx);
      expect(info).toMatchObject({ title: "Plans", archived: true, mode: "acceptEdits", createdAt: "2026-10-01T10:00:00.000Z" });
      expect(((await long.store.agentSettings(long.chat.id, ctx)) as { cwd?: string } | undefined)?.cwd).toBe("/from/log");
    } finally {
      await stores.closeAll();
    }
  });

  test("a compacted chat keeps its summary, the compaction's head on the kept message, and Learn's cursors resume at the same message", async () => {
    const { stores, run } = setup();
    try {
      await run();
      const { entries } = await rows(stores, A, "local-conv-long");
      expect(entries.map((e) => e.kind)).toEqual(["pi.user", "pi.assistant", "pi.user", "pi.assistant", "pi.compaction", "pi.user", "pi.assistant"]);
      const compaction = entries[4];
      expect(compaction.head).toBe(entries[2].id);
      const worker = JSON.parse(readFileSync(paths().recallWorkerFile, "utf8"));
      // Line 6 read means through the compaction: five entries. Line 3 read means u1 and a1: two entries.
      expect(worker.cursors[`${A}/local-conv-long`]).toBe(5);
      expect(worker.leadCursors[`${A}/local-conv-long`]).toBe(2);
      expect(worker.tickMinutes).toBe(10);
      expect(foldSteps(entries.slice(5).flatMap(entrySteps)).map((r) => r.text)).toEqual(["third", "three"]);
    } finally {
      await stores.closeAll();
    }
  });

  test("an API key and a ChatGPT sign-in reach the keychain; Anthropic's subscription is skipped and said so", async () => {
    const { stores, credentials, run } = setup();
    try {
      const report = await run();
      expect(report.credentials.sort()).toEqual(["openai-codex", "openrouter"]);
      expect(await credentials.read("openrouter")).toEqual({ type: "api_key", key: "sk-or-test" });
      expect(await credentials.read("openai-codex")).toEqual({ type: "oauth", access: "acc", refresh: "ref", expires: 123, accountId: "acct" });
      expect(await credentials.read("anthropic")).toBeUndefined();
      expect(report.notes.some((n) => n.startsWith("claude-pro-max: Anthropic"))).toBe(true);
    } finally {
      await stores.closeAll();
    }
  });

  test("active schedules of the imported agents and the pins come over once", async () => {
    const { stores, run } = setup();
    try {
      expect((await run()).schedules).toBe(1);
      const crons = JSON.parse(readFileSync(paths().schedulesFile, "utf8"));
      expect(crons.tasks.map((t: { id: string; fire_count: number }) => [t.id, t.fire_count])).toEqual([["t1", 3]]);
      expect(JSON.parse(readFileSync(paths().pinsFile, "utf8")).agents[A]).toEqual(["local-conv-long"]);
    } finally {
      await stores.closeAll();
    }
  });

  test("with Letta running the import refuses and names it", async () => {
    const { stores, run } = setup();
    try {
      await expect(run(() => "/Applications/Letta.app/Contents/MacOS/Letta")).rejects.toThrow("Letta is running (/Applications/Letta.app");
      expect(existsSync(paths().doneFile)).toBe(false);
    } finally {
      await stores.closeAll();
    }
    expect(runningLetta(() => ["/Applications/Letta.app/Contents/MacOS/Letta", "/usr/bin/node /opt/x/bin/loki"])).toContain("Letta.app");
    expect(runningLetta(() => ["node /Users/x/.npm/bin/letta server --listen ws://127.0.0.1:1"])).toContain("bin/letta");
    expect(runningLetta(() => ["node daemon.mjs --loki-daemon --token-file /x/.letta/loki/token", "/bin/zsh"])).toBeNull();
  });

  test("a second run changes nothing, and a chat the daemon wrote to in between is left alone", async () => {
    const { stores, run } = setup();
    try {
      await run();
      const { chat, store } = await rows(stores, A, "default");
      await store.importEntries(chat, [{ kind: "pi.user", sourceId: "new", line: 99, model: [{ role: "user", content: "written by the daemon", timestamp: 1 }] } as never], ctx);
      const before = (await rows(stores, A, "default")).entries.length;
      const again = await run();
      expect(again.chats).toBe(0);
      expect(again.kept).toBe(3);
      expect(again.schedules).toBe(0);
      expect((await rows(stores, A, "default")).entries.length).toBe(before);
      const worker = JSON.parse(readFileSync(paths().recallWorkerFile, "utf8"));
      expect(worker.cursors[`${A}/local-conv-long`]).toBe(5); // converted once, not again
    } finally {
      await stores.closeAll();
    }
  });
});

describe("Letta's keys", () => {
  test("a provider pi-ai does not know is skipped and said so", () => {
    const file = join(mkdtempSync(join(tmpdir(), "loki-auth-")), "auth.json");
    writeFileSync(file, JSON.stringify({ providers: { mystery: { id: "mystery", provider_type: "mystery", auth: { type: "api", key: "k" } } } }));
    expect(lettaCredentials(file, new Set(["openrouter"]))).toEqual({ credentials: [], skipped: ["mystery: no provider of that name here"] });
  });
});
