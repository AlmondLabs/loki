import { describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { Approvals, kindOf } from "../daemon/approvals.ts";
import { BackgroundTasks } from "../daemon/background.ts";
import { builtinExtensions, builtinKinds } from "../daemon/extensions.ts";
import { GoalsStore } from "../daemon/goals-store.ts";
import { AgentStore } from "../daemon/kernel/index.ts";
import { Schedules } from "../daemon/schedule.ts";
import { subagentExtension } from "../daemon/subagents.ts";

function builtins() {
  const dir = mkdtempSync(join(tmpdir(), "loki-extensions-"));
  const approvals = new Approvals();
  const extensions = builtinExtensions({
    approvals,
    backendDir: dir,
    background: new BackgroundTasks(() => {}),
    schedules: new Schedules(join(dir, "crons.json"), () => Promise.resolve(null)),
    history: { thread: () => [], compactedSince: () => false },
    goals: new GoalsStore(join(dir, "goals.json")),
  });
  return { extensions, dir };
}

describe("the built-in tools", () => {
  test("the permission gate is installed first, and these are the tools every chat has", () => {
    const { extensions, dir } = builtins();
    try {
      expect(extensions[0]?.name).toBe("loki.approvals");
      expect(extensions.find((e) => e.name === "loki.replies")?.sections?.length).toBe(1);
      const names = extensions.flatMap((e) => (e.tools ?? []).map((t) => t.name));
      expect(new Set(names).size).toBe(names.length);
      expect(names.sort()).toEqual(
        [
          "user_ask",
          "background_watch",
          "bash",
          "changes_read",
          "edit",
          "find",
          "goal_create",
          "goal_list",
          "goal_update",
          "grep",
          "history_read",
          "history_search",
          "memory_edit",
          "memory_read",
          "memory_search",
          "memory_write",
          "plan",
          "read",
          "schedule_create",
          "schedule_delete",
          "schedule_list",
          "subagent",
          "subagent_status",
          "subagent_stop",
          "web_fetch",
          "web_search",
          "write",
        ].sort(),
      );
      const scriptsOnly = extensions.flatMap((e) => e.tools ?? []).filter((t) => t.callers?.includes("model") === false);
      expect(scriptsOnly.map((t) => t.name).sort()).toEqual(["history_read", "history_search", "schedule_create", "schedule_delete", "schedule_list"].sort());
      const deferred = extensions.flatMap((e) => e.tools ?? []).filter((t) => t.deferred);
      expect(deferred.map((t) => t.name)).toEqual(["changes_read"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("every built-in tool declares its kind; none falls back to a command for want of one", () => {
    const { extensions, dir } = builtins();
    try {
      const kinds = builtinKinds(extensions);
      const names = extensions.flatMap((e) => (e.tools ?? []).map((t) => t.name));
      expect(names.filter((n) => !kinds.has(n))).toEqual([]);
      expect(Object.fromEntries([...kinds].filter(([, k]) => k !== "read"))).toEqual({
        bash: "command",
        edit: "edit",
        schedule_create: "command",
        schedule_delete: "command",
        subagent_stop: "command",
        write: "edit",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("watch and subagent tools ask for a description of the call as a required string, and wrapped bash adds background and wait_ms", async () => {
    const { extensions, dir } = builtins();
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    for (const e of extensions) registry.install(e);
    const store = await AgentStore.open({ storage: new MemoryStorage() }, { models, registry }, BACKGROUND_CONTEXT);
    try {
      const described = extensions
        .flatMap((e) => e.tools ?? [])
        .filter((t) => ["background_watch", "subagent", "subagent_status", "subagent_stop"].includes(t.name))
        .map((t) => {
          const schema = t.parameters as { properties?: Partial<Record<string, { type?: string }>>; required?: string[] };
          return [t.name, schema.properties?.description?.type, schema.required?.includes("description")];
        });
      expect(described.sort()).toEqual([
        ["background_watch", "string", true],
        ["subagent", "string", true],
        ["subagent_status", "string", true],
        ["subagent_stop", "string", true],
      ]);

      const chat = await store.createChat("c", { agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } } }, BACKGROUND_CONTEXT);
      const bash = (await chat.agent(BACKGROUND_CONTEXT)).tools.find((t) => t.name === "bash");
      const bashSchema = (bash?.parameters ?? {}) as { properties?: Partial<Record<string, { type?: string }>>; required?: string[] };
      expect(bashSchema.properties?.description?.type).toBe("string");
      expect(bashSchema.required?.includes("description")).toBe(true);
      expect(bashSchema.properties?.background?.type).toBe("boolean");
      expect(bashSchema.properties?.wait_ms?.type).toBe("number");
    } finally {
      await store.close(BACKGROUND_CONTEXT);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("every name is snake_case", () => {
    const { extensions, dir } = builtins();
    try {
      const names = extensions.flatMap((e) => (e.tools ?? []).map((t) => t.name));
      expect(names.filter((n) => !/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(n))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a tool that is not loki's: pi-durable's by name, a mod's or MCP's by its annotations, else a command", () => {
    expect(kindOf("write")).toBe("edit");
    expect(kindOf("mcp__github__list_issues", { readOnly: true })).toBe("read");
    expect(kindOf("mcp__github__create_issue")).toBe("command");
  });
});

describe("tools allowed always", () => {
  test("are read as they were saved, without the one that is never allowed always, and the file is left as it is", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-always-"));
    const path = join(dir, "approvals.json");
    try {
      const saved = JSON.stringify({ always: ["bash", "codemode", "user_ask"] });
      writeFileSync(path, saved);
      expect(new Approvals({ alwaysPath: path }).always()).toEqual(["bash", "user_ask"]);
      expect(readFileSync(path, "utf8")).toBe(saved);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a sub-agent call's description", () => {
  test("a call without one still runs, and one with it hands the helper only its prompt", async () => {
    const ctx = BACKGROUND_CONTEXT;
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    registry.install(subagentExtension());
    const store = await AgentStore.open({ storage: new MemoryStorage() }, { models, registry }, ctx);
    try {
      const chat = await store.createChat("c", { agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } } }, ctx);
      const sent: string[] = [];
      const reply = (m: ReturnType<typeof fauxAssistantMessage>) => (c: { messages: unknown[] }) => (sent.push(JSON.stringify(c)), m);
      faux.setResponses([
        reply(fauxAssistantMessage(fauxToolCall("subagent", { prompt: "Count to two." }), { stopReason: "toolUse" })),
        reply(fauxAssistantMessage("one, two")),
        reply(fauxAssistantMessage("Counted to two.")),
        reply(fauxAssistantMessage(fauxToolCall("subagent", { description: "Count with a helper", prompt: "Count to three." }), { stopReason: "toolUse" })),
        reply(fauxAssistantMessage("one, two, three")),
        reply(fauxAssistantMessage("Counted to three.")),
      ]);
      await (await chat.submit({ type: "input", content: "count to two" }, ctx)).wait(ctx);
      await (await chat.submit({ type: "input", content: "count to three" }, ctx)).wait(ctx);
      const results = (await store.entries(chat, ctx)).filter((e) => e.kind === "pi.tool-result").map((e) => JSON.stringify(e.model));
      expect(results).toHaveLength(2);
      expect(results[0]).toContain("one, two");
      expect(results[1]).toContain("one, two, three");
      expect(sent[4]).toContain("Count to three.");
      expect(sent[4]).not.toContain("Count with a helper");
    } finally {
      await store.close(ctx);
    }
  });
});
