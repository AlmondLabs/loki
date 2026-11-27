import { afterAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { extractHarnessEvents } from "../core/harness.ts";
import { AgentStore } from "../daemon/kernel/index.ts";
import { SUBAGENT_NAMES, pickSubagentName, subagentChatId, type SubagentView } from "../core/subagents.ts";
import { subagentExtension, SubagentManager } from "../daemon/subagents.ts";
import { READ_ONLY_TOOLS, readOnlyExtension } from "../daemon/read-only-gate.ts";
import { fileToolsExtension } from "../daemon/tools.ts";
import { createWorktree, removeWorktree } from "../daemon/worktrees.ts";

const ctx = BACKGROUND_CONTEXT;
const cleanupDirs: string[] = [];
const managers: SubagentManager[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function initGitRepo(dir: string): void {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" };
  execFileSync("git", ["init"], { cwd: dir, env, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, env, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, env, stdio: "ignore" });
  mkdirSync(join(dir, "packages", "sub"), { recursive: true });
  writeFileSync(join(dir, "packages", "sub", "note.txt"), "from repo\n");
  execFileSync("git", ["add", "."], { cwd: dir, env, stdio: "ignore" });
  execFileSync("git", ["commit", "--no-gpg-sign", "-m", "init"], { cwd: dir, env, stdio: "ignore" });
}

afterAll(async () => {
  await Promise.all(managers.map((m) => m.stopAll()));
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

describe("git worktrees for subagents", () => {
  test("creates an isolated worktree preserving subdir cwd, rejects non-git folders, and cleans up on remove", async () => {
    const repo = tempDir("loki-wt-repo-");
    const worktreesDir = tempDir("loki-wt-root-");
    initGitRepo(repo);

    const wt = await createWorktree(join(repo, "packages", "sub"), worktreesDir, "sub-1");
    expect(wt.branch).toBe("loki-subagent/sub-1");
    expect(wt.path).toBe(join(worktreesDir, "sub-1"));
    expect(realpathSync.native(wt.repoRoot)).toBe(realpathSync.native(repo));
    expect(realpathSync.native(wt.cwd)).toBe(realpathSync.native(join(wt.path, "packages", "sub")));
    expect(existsSync(join(wt.cwd, "note.txt"))).toBe(true);

    writeFileSync(join(wt.cwd, "note.txt"), "edited in worktree\n");
    expect(execFileSync("git", ["status", "--short"], { cwd: repo, encoding: "utf8" }).trim()).toBe("");

    await removeWorktree(wt);
    expect(existsSync(wt.path)).toBe(false);

    const plain = tempDir("loki-plain-");
    await expect(createWorktree(plain, worktreesDir, "sub-2")).rejects.toThrow("requires a git repository");
  });
});

async function harnessSetup(
  cwd: string,
  opts: { extraModels?: Array<{ id: string; inputCost: number; reasoning?: boolean }>; pickName?: (used: ReadonlySet<string>) => string } = {},
) {
  const worktreesDir = tempDir("loki-sub-wt-");
  const backendDir = tempDir("loki-sub-backend-");
  const faux = fauxProvider({
    models: opts.extraModels?.map((m) => ({
      id: m.id,
      reasoning: m.reasoning ?? false,
      cost: { input: m.inputCost, output: m.inputCost * 2, cacheRead: 0, cacheWrite: 0 },
    })),
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const notices: Array<{ agentId: string; chatId: string; text: string }> = [];
  let resolveStore!: (store: AgentStore) => void;
  const storePromise = new Promise<AgentStore>((r) => {
    resolveStore = r;
  });
  const manager = new SubagentManager({
    notify: (agentId, chatId, text) => {
      notices.push({ agentId, chatId, text });
    },
    storeFor: () => storePromise,
    context: ctx,
    worktreesDir,
    pickName: opts.pickName ?? ((used) => pickSubagentName(used, 0)),
  });
  managers.push(manager);
  for (const ext of [fileToolsExtension(), readOnlyExtension(backendDir), subagentExtension(manager)]) registry.install(ext);
  const storeRef = await AgentStore.open({ storage: new MemoryStorage() }, { models, registry }, ctx);
  resolveStore(storeRef);
  await storeRef.setAgent({ id: "agent-a", name: "Ada" }, ctx);
  const mainModel = faux.getModel().id;
  const chat = await storeRef.createChat("c", { agent: { model: { provider: faux.provider.id, modelId: mainModel }, cwd } }, ctx);
  const results = async () => (await storeRef.entries(chat, ctx)).filter((e) => e.kind === "pi.tool-result").map((e) => JSON.stringify(e.model));
  return { store: storeRef, faux, models, chat, notices, manager, results, worktreesDir, backendDir };
}

describe("async, continuation, and worktree subagents", () => {
  function routeResponses(
    faux: ReturnType<typeof fauxProvider>,
    parentMarker: string,
    parentSteps: Array<ReturnType<typeof fauxAssistantMessage> | FauxResponseFactory>,
    helperSteps: Array<ReturnType<typeof fauxAssistantMessage> | FauxResponseFactory>,
  ) {
    let pIdx = 0;
    let hIdx = 0;
    const step: FauxResponseFactory = (context, options, state, model) => {
      const isParent = JSON.stringify(context.messages).includes(parentMarker);
      const list = isParent ? parentSteps : helperSteps;
      const idx = isParent ? pIdx++ : hIdx++;
      if (idx >= list.length) throw new Error(`unexpected extra ${isParent ? "parent" : "helper"} call #${idx}`);
      const next = list[idx];
      return typeof next === "function" ? next(context, options, state, model) : next;
    };
    faux.setResponses(Array.from({ length: parentSteps.length + helperSteps.length }, () => step));
  }

  test("async: true returns immediately, notifies parent chat on completion, and parses as subagent event", async () => {
    const dir = tempDir("loki-sub-async-");
    const t = await harnessSetup(dir);
    let releaseHelper!: () => void;
    const helperGate = new Promise<void>((resolve) => {
      releaseHelper = resolve;
    });
    try {
      routeResponses(
        t.faux,
        "launch helper",
        [
          fauxAssistantMessage(fauxToolCall("subagent", { description: "Audit config", prompt: "Inspect things", async: true }), {
            stopReason: "toolUse",
          }),
          fauxAssistantMessage("Started helper, continuing work."),
        ],
        [
          async () => {
            await helperGate;
            return fauxAssistantMessage("Audit complete: all clean.");
          },
        ],
      );

      await (await t.chat.submit({ type: "input", content: "launch helper" }, ctx)).wait(ctx);
      expect((await t.results())[0]).toContain("started subagent atlas");
      expect(t.notices).toEqual([]);

      releaseHelper();
      const until = Date.now() + 3000;
      while (!t.notices.length && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
      expect(t.notices).toHaveLength(1);
      expect(t.notices[0]).toMatchObject({ agentId: "agent-a", chatId: "c" });
      expect(t.notices[0].text).toContain("<kind>subagent</kind>");
      expect(t.notices[0].text).toContain("<task-id>atlas</task-id>");
      expect(t.notices[0].text).toContain(`<chat-id>${subagentChatId("c", "atlas")}</chat-id>`);
      expect(t.notices[0].text).toContain("Audit complete: all clean.");
      expect(extractHarnessEvents(t.notices[0].text)[0]).toMatchObject({
        text: "subagent atlas completed",
        summary: "Audit config",
        subagent_chat: subagentChatId("c", "atlas"),
        event: "subagent",
      });

      const subChatId = subagentChatId("c", "atlas");
      const atlasConv = await t.store.chat(subChatId, ctx);
      if (!atlasConv) throw new Error("expected atlas chat to be indexed");
      const doc = await t.store.chatInfo(atlasConv.id, ctx);
      expect(doc).toMatchObject({ id: subChatId, hidden: true, subagent_for: "c", subagent_meta: { id: "atlas", name: "Atlas" } });
    } finally {
      releaseHelper();
      await t.manager.stopAll();
      await t.store.close(ctx);
    }
  });

  test("subagent_status lists and waits without duplicate notice; subagent_id continues; worktree persists until subagent_stop", async () => {
    const repo = tempDir("loki-sub-repo-");
    initGitRepo(repo);
    const t = await harnessSetup(repo);
    let notifyResolve!: () => void;
    const childStarted = new Promise<void>((resolve) => {
      notifyResolve = resolve;
    });
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });

    try {
      routeResponses(
        t.faux,
        "run workflow",
        [
          fauxAssistantMessage(
            fauxToolCall("subagent", { description: "Isolate edit", prompt: "Check repo in worktree", workspace: "worktree", async: true }),
            {
              stopReason: "toolUse",
            },
          ),
          fauxAssistantMessage(fauxToolCall("subagent_status", { description: "List helpers" }), { stopReason: "toolUse" }),
          fauxAssistantMessage(fauxToolCall("subagent_status", { description: "Wait on atlas", subagent_id: "atlas", wait_ms: 5000 }), {
            stopReason: "toolUse",
          }),
          fauxAssistantMessage(fauxToolCall("subagent", { description: "Follow up", subagent_id: "atlas", prompt: "Follow-up question" }), {
            stopReason: "toolUse",
          }),
          fauxAssistantMessage(fauxToolCall("subagent_stop", { description: "Clean up worktree", subagent_id: "atlas" }), { stopReason: "toolUse" }),
          fauxAssistantMessage("All cleaned up."),
        ],
        [
          async () => {
            notifyResolve();
            await childGate;
            return fauxAssistantMessage("Worktree inspected.");
          },
          fauxAssistantMessage("Second answer from same helper."),
        ],
      );

      const turnPromise = (await t.chat.submit({ type: "input", content: "run workflow" }, ctx)).wait(ctx);
      await childStarted;
      const run = t.manager.get("atlas", "agent-a");
      expect(run.worktree).not.toBeNull();
      const wtPath = run.worktree?.path ?? "";
      expect(existsSync(wtPath)).toBe(true);
      expect(run.cwd).toBe(wtPath);

      setTimeout(releaseChild, 40);
      await turnPromise;

      const toolResults = await t.results();
      expect(toolResults[0]).toContain("started subagent atlas in worktree");
      expect(toolResults[1]).toContain("atlas [running] (branch loki-subagent/atlas)");
      expect(toolResults[2]).toContain("status: done");
      expect(toolResults[2]).toContain("Worktree inspected.");
      expect(toolResults[3]).toContain("Second answer from same helper.");
      expect(toolResults[4]).toContain("removed worktree");
      expect(existsSync(wtPath)).toBe(false);
      expect(t.notices).toEqual([]);
    } finally {
      releaseChild();
      await t.manager.stopAll();
      await t.store.close(ctx);
    }
  });

  test("subagent_stop aborts a running async helper without sending completion notice and optionally keeps worktree", async () => {
    const repo = tempDir("loki-sub-stop-repo-");
    initGitRepo(repo);
    const t = await harnessSetup(repo);

    try {
      routeResponses(
        t.faux,
        "start and stop",
        [
          fauxAssistantMessage(fauxToolCall("subagent", { description: "Long task", prompt: "Wait forever", workspace: "worktree", async: true }), {
            stopReason: "toolUse",
          }),
          fauxAssistantMessage(fauxToolCall("subagent_stop", { description: "Stop keeping worktree", subagent_id: "atlas", remove_worktree: false }), {
            stopReason: "toolUse",
          }),
          fauxAssistantMessage("Stopped helper."),
        ],
        [
          (_context, options) => {
            if (options?.signal?.aborted) return fauxAssistantMessage("aborted");
            return new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
              options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("aborted")), { once: true });
            });
          },
        ],
      );

      await (await t.chat.submit({ type: "input", content: "start and stop" }, ctx)).wait(ctx);
      const toolResults = await t.results();
      expect(toolResults[1]).toContain("Stopped subagent atlas");
      expect(toolResults[1]).toContain("kept worktree");
      const run = t.manager.get("atlas", "agent-a");
      expect(run.status).toBe("stopped");
      expect(run.worktree).not.toBeNull();
      expect(existsSync(run.worktree?.path ?? "")).toBe(true);
      expect(t.notices).toEqual([]);
    } finally {
      await t.manager.stopAll();
      await t.store.close(ctx);
    }
  });
});

describe("named workers, hybrid models, read_only, and views", () => {
  test("hybrid model selection picks fast, strong, and explicit handles, and supports read_only while rejecting worktree+read_only", async () => {
    const dir = tempDir("loki-sub-hybrid-");
    const t = await harnessSetup(dir, {
      extraModels: [
        { id: "mini-fast", inputCost: 0.1, reasoning: true },
        { id: "gpt-5-strong", inputCost: 5.0, reasoning: true },
      ],
    });
    const seenViews: SubagentView[][] = [];
    const off = t.manager.onChange(() => {
      void t.manager.views("agent-a", "c").then((v) => seenViews.push(v));
    });
    const usedModels: string[] = [];
    const parentPrompts: Array<ReturnType<typeof fauxAssistantMessage>> = [
      fauxAssistantMessage(
        fauxToolCall("subagent", { description: "Fast read-only scan", prompt: "Scan repo", model: "fast", reasoning_effort: "low", read_only: true }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxToolCall("subagent", { description: "Strong review", prompt: "Deep check", model: "strong", reasoning_effort: "high" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(fauxToolCall("subagent", { description: "Invalid combo", prompt: "Should fail", read_only: true, workspace: "worktree" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("All done."),
    ];
    let pIdx = 0;
    let hIdx = 0;
    t.faux.setResponses(
      Array.from({ length: 6 }, () => (context, _opts, _state, model) => {
        if (JSON.stringify(context.messages).includes("run hybrid workers")) return parentPrompts[pIdx++];
        usedModels.push(model.id);
        hIdx++;
        return fauxAssistantMessage(`helper-${hIdx} ok`);
      }),
    );

    try {
      await (await t.chat.submit({ type: "input", content: "run hybrid workers" }, ctx)).wait(ctx);
      expect(usedModels).toEqual(["mini-fast", "gpt-5-strong"]);

      const results = await t.results();
      expect(results[2]).toContain("read_only subagents cannot use workspace");

      const views = await t.manager.views("agent-a", "c");
      const summary = views.map((v) => [v.id, v.name, v.read_only ?? false, v.model]);
      expect(summary).toHaveLength(2);
      expect(summary).toContainEqual(["atlas", "Atlas", true, `${t.faux.provider.id}/mini-fast`]);
      expect(summary).toContainEqual(["beacon", "Beacon", false, `${t.faux.provider.id}/gpt-5-strong`]);
      expect(SUBAGENT_NAMES).toContain(views[0].id);
      expect(SUBAGENT_NAMES).toContain(views[1].id);
      expect(seenViews.length).toBeGreaterThanOrEqual(2);

      const atlasChat = await t.store.chat(subagentChatId("c", "atlas"), ctx);
      if (!atlasChat) throw new Error("expected atlas chat");
      const settings = (await t.store.agentSettings(atlasChat.id, ctx)) as { tools?: string[] };
      expect(settings.tools).toEqual(["find", "grep"]);
      expect(settings.tools?.every((name) => READ_ONLY_TOOLS.includes(name))).toBe(true);
    } finally {
      off();
      await t.manager.stopAll();
      await t.store.close(ctx);
    }
  });

  test("persisted subagent chats stay discoverable across SubagentManager restarts and allocate distinct cool names", async () => {
    const dir = tempDir("loki-sub-restart-");
    const dbFile = join(dir, "agent.sqlite");
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    let store = await AgentStore.open({ file: dbFile }, { models, registry }, ctx);
    await store.setAgent({ id: "agent-a", name: "Ada" }, ctx);

    const manager1 = new SubagentManager({
      storeFor: () => Promise.resolve(store),
      context: ctx,
      pickName: (used) => pickSubagentName(used, 0),
    });
    registry.install(fileToolsExtension());
    registry.install(subagentExtension(manager1));
    const chat1 = await store.createChat("c", { agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id }, cwd: dir } }, ctx);
    faux.setResponses([
      () => fauxAssistantMessage(fauxToolCall("subagent", { description: "First", prompt: "One" }), { stopReason: "toolUse" }),
      () => fauxAssistantMessage("done 1"),
      () => fauxAssistantMessage("parent done"),
    ]);
    await (await chat1.submit({ type: "input", content: "first" }, ctx)).wait(ctx);
    expect((await manager1.views("agent-a", "c")).map((v) => v.id)).toEqual(["atlas"]);
    await manager1.stopAll();
    await store.close(ctx);

    const registry2 = createRegistry();
    const manager2 = new SubagentManager({
      storeFor: () => Promise.resolve(store),
      context: ctx,
      pickName: (used) => pickSubagentName(used, 0),
    });
    registry2.install(fileToolsExtension());
    registry2.install(subagentExtension(manager2));
    store = await AgentStore.open({ file: dbFile }, { models, registry: registry2 }, ctx);
    try {
      const viewsBefore = await manager2.views("agent-a", "c");
      expect(viewsBefore.map((v) => v.id)).toEqual(["atlas"]);

      const chat2 = await store.chat("c", ctx);
      if (!chat2) throw new Error("expected parent chat");
      faux.setResponses([
        () => fauxAssistantMessage(fauxToolCall("subagent", { description: "Second", prompt: "Two" }), { stopReason: "toolUse" }),
        () => fauxAssistantMessage("done 2"),
        () => fauxAssistantMessage("parent done 2"),
      ]);
      await (await chat2.submit({ type: "input", content: "second" }, ctx)).wait(ctx);
      const viewsAfter = await manager2.views("agent-a", "c");
      expect(new Set(viewsAfter.map((v) => v.id))).toEqual(new Set(["atlas", "beacon"]));
    } finally {
      await manager2.stopAll();
      await store.close(ctx);
    }
  });
});
