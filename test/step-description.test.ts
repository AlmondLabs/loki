import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { defineExtension, MemoryStorage, type ToolRegistration } from "@earendil-works/pi-durable";
import { Approvals, asks } from "../daemon/approvals.ts";
import { BackgroundTasks } from "../daemon/background.ts";
import { builtinExtensions } from "../daemon/extensions.ts";
import { AgentStore } from "../daemon/kernel/index.ts";
import type { LokiMod } from "../daemon/mods/api.ts";
import { ModRegistry } from "../daemon/mods/registry.ts";
import { Schedules } from "../daemon/schedule.ts";
import { chatEnvs } from "../daemon/tool-results.ts";

const ctx = BACKGROUND_CONTEXT;

async function chatWithBuiltins(mod?: LokiMod) {
  const dir = mkdtempSync(join(tmpdir(), "loki-step-description-"));
  const mods = new ModRegistry(() => {});
  const extensions = builtinExtensions({
    approvals: new Approvals(),
    backendDir: dir,
    background: new BackgroundTasks(() => {}),
    schedules: new Schedules(join(dir, "crons.json"), () => Promise.resolve(null)),
    history: { thread: () => [], compactedSince: () => false },
  });
  const bashReceived: unknown[] = [];
  const bashSpy = defineExtension({
    name: "test.bash-spy",
    wraps: [
      {
        tool: "bash",
        wrap: (tool: ToolRegistration): ToolRegistration => ({
          ...tool,
          execute: (args, api, context) => (bashReceived.push(args), tool.execute(args, api, context)),
        }),
      },
    ],
  });
  const codingTools = extensions.findIndex((e) => e.name === "coding-tools");
  extensions.splice(codingTools + 1, 0, bashSpy);
  for (const extension of extensions) mods.registry.install(extension);
  if (mod) expect(await mods.load(mod)).toEqual({ loaded: true });
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const store = await AgentStore.open({ storage: new MemoryStorage() }, { models, registry: mods.registry, env: chatEnvs(dir) }, ctx);
  const chat = await store.createChat("c", { agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id }, cwd: dir } }, ctx);
  const offered: unknown[] = [];
  const reply = (m: ReturnType<typeof fauxAssistantMessage>) => (c: { messages: unknown[] }) => (
    offered.push(getCurrentTools(c.messages as never).find((t) => t.name === "bash")?.parameters),
    m
  );
  const bashTurn = async (args: { command: string; description?: string }) => {
    faux.setResponses([reply(fauxAssistantMessage(fauxToolCall("bash", args), { stopReason: "toolUse" })), reply(fauxAssistantMessage("done"))]);
    await (await chat.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
  };
  const results = async () => (await store.entries(chat, ctx)).filter((e) => e.kind === "pi.tool-result").map((e) => JSON.stringify(e.model));
  const cleanup = async () => {
    await store.close(ctx);
    rmSync(dir, { recursive: true, force: true });
  };
  return { bashTurn, results, offered, bashReceived, cleanup };
}

describe("bash's step description", () => {
  test("a chat offers bash with a description it is told is required", async () => {
    const s = await chatWithBuiltins();
    try {
      await s.bashTurn({ description: "Say hello", command: "echo hello" });
      expect(s.offered[0]).toMatchObject({
        properties: { description: { type: "string" } },
        required: expect.arrayContaining(["description", "command"]) as unknown,
      });
    } finally {
      await s.cleanup();
    }
  });

  test("a call with only a command runs it, and one with a description runs the same command; bash never receives the description", async () => {
    const s = await chatWithBuiltins();
    try {
      await s.bashTurn({ command: "echo first-ran" });
      await s.bashTurn({ description: "Say it again", command: "echo second-ran" });
      const [first, second] = await s.results();
      expect(first).toContain("first-ran");
      expect(second).toContain("second-ran");
      expect(s.bashReceived).toEqual([{ command: "echo first-ran" }, { command: "echo second-ran" }]);
    } finally {
      await s.cleanup();
    }
  });

  test("a mod that hands bash new arguments without the description still runs them", async () => {
    const mod: LokiMod = {
      name: "rewrite",
      apiVersion: 1,
      activate: (api) => {
        api.beforeTool((call) => (call.name === "bash" ? { args: { command: "echo rewritten" } } : undefined));
      },
    };
    const s = await chatWithBuiltins(mod);
    try {
      await s.bashTurn({ description: "Say the original", command: "echo original" });
      const [result] = await s.results();
      expect(result).toContain("rewritten");
      expect(result).not.toContain("Validation failed");
      expect(s.bashReceived).toEqual([{ command: "echo rewritten" }]);
    } finally {
      await s.cleanup();
    }
  });

  test("a described ls is still a read, so standard mode runs it without asking", () => {
    expect(asks("standard", "bash", { description: "List the files", command: "ls" }, {})).toBe(false);
    expect(asks("standard", "bash", { description: "Remove a file", command: "rm a.ts" }, {})).toBe(true);
  });
});
