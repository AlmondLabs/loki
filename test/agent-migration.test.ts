import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { backendName } from "../core/desk-core.ts";
import { migrateAgents, piHandle, settingsNow } from "../daemon/agent-migration.ts";
import { AgentStore } from "../daemon/kernel/index.ts";
import { StoreManager } from "../daemon/kernel/stores.ts";
import { ModRegistry } from "../daemon/mods/registry.ts";
import { writeRecord } from "../daemon/store/agents.ts";
import { must } from "./fixtures/must.ts";

const ctx = BACKGROUND_CONTEXT;
const AGENT = "agent-local-ira";
const HELPER = "agent-local-helper";
const known = (provider: string) => provider === "openai-codex" || provider === "openrouter";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe("a model handle by pi-ai's provider name", () => {
  test("a known provider stays; Letta's doubled prefix and its name for ChatGPT's provider are translated", () => {
    expect(piHandle("openai-codex/gpt-6.1-sol", known)).toBe("openai-codex/gpt-6.1-sol");
    expect(piHandle("openrouter/anthropic/claude-haiku", known)).toBe("openrouter/anthropic/claude-haiku");
    expect(piHandle("chatgpt-plus-pro/gpt-6-luna", known)).toBe("openai-codex/gpt-6-luna");
    expect(piHandle("chatgpt-plus-pro/chatgpt-plus-pro/openai-codex/gpt-6.1-sol", known)).toBe("openai-codex/gpt-6.1-sol");
    expect(piHandle("elsewhere/auto", known)).toBe("elsewhere/auto");
    expect(piHandle("gpt", known)).toBe("gpt");
  });
});

describe("an agent's model_settings", () => {
  test("keep effort as reasoning_effort alone, and drop the provider's type; settings already so are left", () => {
    expect(settingsNow({ provider_type: "chatgpt_oauth", reasoning: { reasoning_effort: "medium" }, context_window_limit: 272000 })).toEqual({
      context_window_limit: 272000,
      reasoning_effort: "medium",
    });
    expect(settingsNow({ effort: "high" })).toEqual({ reasoning_effort: "high" });
    expect(settingsNow({ thinking: { type: "disabled" } })).toEqual({ reasoning_effort: "none" });
    expect(settingsNow({ reasoning_effort: "low", context_window_limit: 1 })).toBeNull();
  });
});

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "loki-agent-migration-"));
  const backend = join(dir, "backend");
  writeRecord(backend, AGENT, {
    id: AGENT,
    name: "ira",
    tags: ["origin:letta-code"],
    model: "chatgpt-plus-pro/openai-codex/gpt-6.1-sol",
    model_settings: { provider_type: "chatgpt_oauth", reasoning_effort: "medium", reasoning: { reasoning_effort: "medium" } },
  });
  writeRecord(backend, HELPER, { id: HELPER, name: "Letta Code", tags: ["role:subagent"] });
  const memory = join(backend, "memfs", AGENT, "memory");
  mkdirSync(join(memory, "reference"), { recursive: true });
  writeFileSync(join(memory, "reference", "widgets.md"), "Widgets live in /Users/x/.letta/loki/widgets/shared.\n");
  const git = (...args: string[]) => execFileSync("git", ["-C", memory, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  git("init", "--quiet");
  git("add", "-A");
  git("commit", "--quiet", "-m", "Begin memory");
  const models = createModels();
  const mods = new ModRegistry(() => {});
  const stores = new StoreManager(
    join(dir, "stores"),
    { models, registry: mods.registry },
    ctx,
    () => {},
    () => AgentStore.open({ storage: new MemoryStorage() }, { models, registry: mods.registry }, ctx),
  );
  const store = await stores.get(AGENT);
  const letta = { provider: "chatgpt-plus-pro", modelId: "openai-codex/gpt-6.1-sol" };
  await store.createChat("local-conv-old", { agent: { model: letta } }, ctx);
  const writer = await store.createChat("local-conv-writer", {}, ctx);
  await writer.configure({ cwd: "/Users/x/.letta/loki/recall" }, ctx);
  await store.createChat("local-conv-claude", { agent: { model: letta } }, ctx);
  await store.updateChat("local-conv-claude", { engine: { kind: "acp", agent: "claude", model: "default", session_id: null } }, ctx);
  const worker = join(dir, "worker.json");
  writeFileSync(worker, JSON.stringify({ writers: { [AGENT]: "local-conv-writer" } }));
  const reports: string[] = [];
  const deps = {
    backendDir: backend,
    stores,
    known,
    learnWorkerFile: worker,
    stateFile: join(dir, "state", "migrations.json"),
    backupDir: join(backend, "backup-letta-2026-10-28"),
    context: ctx,
    report: (line: string) => reports.push(line),
  };
  cleanups.push(async () => {
    await stores.closeAll();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, backend, memory, store, deps, reports, git };
}

const settingsOf = async (store: AgentStore, chatId: string) =>
  (await store.agentSettings(must(await store.chat(chatId, ctx), chatId).id, ctx)) as { model?: { provider: string; modelId: string }; cwd?: string };

describe("the agents' migration (plan 045)", () => {
  test("records, memory and chats' settings take loki's shapes once; a helper's record moves out; an ACP chat is left", async () => {
    const { backend, memory, store, deps, reports, git } = await setup();
    expect(await migrateAgents(deps)).toBe(true);

    const record = JSON.parse(readFileSync(join(backend, "agents", `${backendName(AGENT)}.json`), "utf8")) as Record<string, unknown>;
    expect(record.model).toBe("openai-codex/gpt-6.1-sol");
    expect(record.model_settings).toEqual({ reasoning_effort: "medium" });
    expect(existsSync(join(backend, "agents", `${backendName(HELPER)}.json`))).toBe(false);
    expect(existsSync(join(deps.backupDir, "agents", `${backendName(HELPER)}.json`))).toBe(true);

    expect(readFileSync(join(memory, "reference", "widgets.md"), "utf8")).toBe("Widgets live in /Users/x/.loki/widgets/shared.\n");
    expect(String(git("log", "-1", "--format=%an %s"))).toMatch(/^loki Name ~\/\.loki/);

    expect((await settingsOf(store, "local-conv-old")).model).toEqual({ provider: "openai-codex", modelId: "gpt-6.1-sol" });
    expect((await settingsOf(store, "local-conv-writer")).cwd).toBe("/Users/x/.loki/recall");
    expect((await store.chatInfo(must(await store.chat("local-conv-writer", ctx), "writer").id, ctx))?.hidden).toBe(true);
    expect((await settingsOf(store, "local-conv-claude")).model?.provider).toBe("chatgpt-plus-pro");
    expect(reports.length).toBeGreaterThan(0);

    // A second start reads nothing.
    expect(await migrateAgents(deps)).toBe(false);
  });
});
