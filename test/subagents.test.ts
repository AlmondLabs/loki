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
import { subagentExtension, SubagentManager } from "../daemon/subagents.ts";
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

describe("async, continuation, and worktree subagents", () => {
  async function harnessSetup(cwd: string) {
    const worktreesDir = tempDir("loki-sub-wt-");
    const faux = fauxProvider();
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
      harnessFor: async () => (await storePromise).harness,
      context: ctx,
      worktreesDir,
    });
    managers.push(manager);
    for (const ext of [fileToolsExtension(), subagentExtension(manager)]) registry.install(ext);
    const storeRef = await AgentStore.open({ storage: new MemoryStorage() }, { models, registry }, ctx);
    resolveStore(storeRef);
    await storeRef.setAgent({ id: "agent-a", name: "Ada" }, ctx);
    const chat = await storeRef.createChat("c", { agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id }, cwd } }, ctx);
    const results = async () => (await storeRef.entries(chat, ctx)).filter((e) => e.kind === "pi.tool-result").map((e) => JSON.stringify(e.model));
    return { store: storeRef, faux, chat, notices, manager, results };
  }

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
      expect((await t.results())[0]).toContain("started subagent sub-1");
      expect(t.notices).toEqual([]);

      releaseHelper();
      const until = Date.now() + 3000;
      while (!t.notices.length && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
      expect(t.notices).toHaveLength(1);
      expect(t.notices[0]).toMatchObject({ agentId: "agent-a", chatId: "c" });
      expect(t.notices[0].text).toContain("<kind>subagent</kind>");
      expect(t.notices[0].text).toContain("<task-id>sub-1</task-id>");
      expect(t.notices[0].text).toContain("Audit complete: all clean.");
      expect(extractHarnessEvents(t.notices[0].text)[0]).toMatchObject({
        text: "subagent sub-1 completed",
        summary: "Audit config",
      });
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
          fauxAssistantMessage(fauxToolCall("subagent_status", { description: "Wait on sub-1", subagent_id: "sub-1", wait_ms: 5000 }), {
            stopReason: "toolUse",
          }),
          fauxAssistantMessage(fauxToolCall("subagent", { description: "Follow up", subagent_id: "sub-1", prompt: "Follow-up question" }), {
            stopReason: "toolUse",
          }),
          fauxAssistantMessage(fauxToolCall("subagent_stop", { description: "Clean up worktree", subagent_id: "sub-1" }), { stopReason: "toolUse" }),
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
      const run = t.manager.get("sub-1", "agent-a");
      expect(run.worktree).not.toBeNull();
      const wtPath = run.worktree?.path ?? "";
      expect(existsSync(wtPath)).toBe(true);
      expect(run.cwd).toBe(wtPath);

      setTimeout(releaseChild, 40);
      await turnPromise;

      const toolResults = await t.results();
      expect(toolResults[0]).toContain("started subagent sub-1 in worktree");
      expect(toolResults[1]).toContain("sub-1 [running] (branch loki-subagent/sub-1)");
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
          fauxAssistantMessage(fauxToolCall("subagent_stop", { description: "Stop keeping worktree", subagent_id: "sub-1", remove_worktree: false }), {
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
      expect(toolResults[1]).toContain("Stopped subagent sub-1");
      expect(toolResults[1]).toContain("kept worktree");
      const run = t.manager.get("sub-1", "agent-a");
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
