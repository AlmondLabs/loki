import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { createAgent } from "../daemon/store/agents.ts";
import { AgentStore } from "../daemon/kernel/index.ts";
import { must } from "./fixtures/must.ts";
import { editMemoryFile, memoryDump, memoryExtension, memoryRoot, memorySection, revertMemoryCommit, sharedMemoryRoot } from "../daemon/memory.ts";

const ctx = BACKGROUND_CONTEXT;
const log = (root: string) => execFileSync("git", ["-C", root, "log", "--format=%an|%s"], { encoding: "utf8" }).trim().split("\n");

describe("an agent's memory", () => {
  test("the system files are in the section in full, and the other files are listed by path", () => {
    const root = mkdtempSync(join(tmpdir(), "loki-memory-"));
    try {
      mkdirSync(join(root, "system"));
      mkdirSync(join(root, "reference"));
      writeFileSync(join(root, "system", "persona.md"), "I am careful.\n");
      writeFileSync(join(root, "system", "human.md"), "Deepak likes numbered lists.\n");
      writeFileSync(join(root, "reference", "notes.md"), "long notes");
      const text = must(memorySection(root), "the memory section");
      expect(text).toContain('<file path="system/human.md">\nDeepak likes numbered lists.\n</file>');
      expect(text).toContain('<file path="system/persona.md">\nI am careful.\n</file>');
      expect(text).toContain("- reference/notes.md");
      expect(text).not.toContain("long notes");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("without a system folder, the top-level markdown files are the section; no memory, no section", () => {
    const root = mkdtempSync(join(tmpdir(), "loki-memory-"));
    try {
      writeFileSync(join(root, "MEMORY.md"), "the index");
      writeFileSync(join(root, "mission.md"), "the mission");
      const text = must(memorySection(root), "the memory section");
      expect(text).toContain('<file path="MEMORY.md">\nthe index\n</file>');
      expect(text).toContain('<file path="mission.md">\nthe mission\n</file>');
      expect(memorySection(join(root, "nope"))).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the agent writes and edits its memory in a chat; each change is its commit, and the next request sees it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-memory-"));
    try {
      const agentId = await createAgent(dir, { name: "Ada" });
      const faux = fauxProvider();
      const models = createModels();
      models.setProvider(faux.provider);
      const registry = createRegistry();
      registry.install(memoryExtension(dir));
      const store = await AgentStore.open({ storage: new MemoryStorage() }, { models, registry }, ctx);
      await store.setAgent({ id: agentId, name: "Ada" }, ctx);
      const chat = await store.createChat("c", { agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } } }, ctx);
      const sent: string[] = [];
      const reply = (m: ReturnType<typeof fauxAssistantMessage>) => (c: { systemPrompt?: string; messages: unknown[] }) => (sent.push(JSON.stringify(c)), m);
      faux.setResponses([
        reply(
          fauxAssistantMessage(fauxToolCall("memory_write", { path: "system/human.md", content: "Likes tea.\n", message: "Note the tea" }), {
            stopReason: "toolUse",
          }),
        ),
        reply(
          fauxAssistantMessage(fauxToolCall("memory_edit", { path: "system/human.md", old_text: "tea", new_text: "green tea" }), { stopReason: "toolUse" }),
        ),
        reply(fauxAssistantMessage(fauxToolCall("memory_read", { path: "../../etc/passwd" }), { stopReason: "toolUse" })),
        reply(fauxAssistantMessage("noted")),
      ]);
      await (await chat.submit({ type: "input", content: "I like tea" }, ctx)).wait(ctx);
      const root = memoryRoot(dir, agentId);
      expect(readFileSync(join(root, "system", "human.md"), "utf8")).toBe("Likes green tea.\n");
      expect(log(root)).toEqual(["Ada|Edit system/human.md", "Ada|Note the tea", "Ada|Begin memory"]);
      expect(sent[0]).toContain("I am Ada.");
      expect(sent[2]).toContain("Likes green tea.");
      expect(sent[3]).toContain("is not a memory file");
      await store.close(ctx);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a change from the Agents page is committed as the person's, and a removal too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-memory-"));
    try {
      const agentId = await createAgent(dir, { name: "Ada" });
      await editMemoryFile(dir, agentId, "reference/a.md", "hello", "Add a");
      await editMemoryFile(dir, agentId, "reference/a.md", null);
      expect(log(memoryRoot(dir, agentId))).toEqual(["You|Remove reference/a.md", "You|Add a", "Ada|Begin memory"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a note saved again with the same text is no error and no commit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-memory-"));
    try {
      const agentId = await createAgent(dir, { name: "Ada" });
      await editMemoryFile(dir, agentId, "reference/a.md", "hello", "Add a");
      await editMemoryFile(dir, agentId, "reference/a.md", "hello", "Add a again");
      expect(log(memoryRoot(dir, agentId))).toEqual(["You|Add a", "Ada|Begin memory"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("edits landing at once are each committed: one git at a time per repo, not a lost index.lock race", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-memory-"));
    try {
      const agentId = await createAgent(dir, { name: "Ada" });
      await Promise.all(Array.from({ length: 12 }, (_, i) => editMemoryFile(dir, agentId, `reference/n${i}.md`, `note ${i}`, `Add n${i}`)));
      const commits = log(memoryRoot(dir, agentId));
      expect(commits).toHaveLength(13);
      for (let i = 0; i < 12; i++) expect(commits).toContain(`You|Add n${i}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("git's own files are not memory files, in any case, at any depth", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-memory-"));
    try {
      const agentId = await createAgent(dir, { name: "Ada" });
      const root = memoryRoot(dir, agentId);
      const config = readFileSync(join(root, ".git", "config"), "utf8");
      for (const path of [
        ".git/config",
        ".GIT/config",
        ".Git/hooks/pre-commit",
        "notes/.git/config",
        ".gitattributes",
        "notes/.GitAttributes",
        ".gitmodules",
        "../outside.md",
        // Outside (Windows): `relative` to another drive gives the path back absolute, with no "..".
        ...(process.platform === "win32" ? ["D:\\outside.md"] : []),
      ])
        await expect(editMemoryFile(dir, agentId, path, "x")).rejects.toThrow("is not a memory file");
      expect(readFileSync(join(root, ".git", "config"), "utf8")).toBe(config);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a commit runs none of the repo's hooks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-memory-"));
    try {
      const agentId = await createAgent(dir, { name: "Ada" });
      const root = memoryRoot(dir, agentId);
      const ran = join(dir, "hook-ran");
      mkdirSync(join(root, ".git", "hooks"), { recursive: true });
      writeFileSync(join(root, ".git", "hooks", "pre-commit"), `#!/bin/sh\ntouch "${ran}"\n`, { mode: 0o755 });
      await editMemoryFile(dir, agentId, "reference/a.md", "hello", "Add a");
      expect(existsSync(ran)).toBe(false);
      expect(log(root)[0]).toBe("You|Add a");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a commit is undone by a new commit as yours; one a later change overlaps is refused, and the repo is left clean", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-memory-"));
    try {
      const agentId = await createAgent(dir, { name: "Ada" });
      const root = memoryRoot(dir, agentId);
      const head = () => execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      await editMemoryFile(dir, agentId, "notes.md", "one\ntwo\n", "Add notes");
      await editMemoryFile(dir, agentId, "notes.md", "one\nTWO\n", "Shout two");
      await revertMemoryCommit(dir, agentId, head());
      expect(readFileSync(join(root, "notes.md"), "utf8")).toBe("one\ntwo\n");
      expect(log(root)[0]).toBe('You|Revert "Shout two"');
      await editMemoryFile(dir, agentId, "notes.md", "one\nthree\n", "Three");
      const three = head();
      await editMemoryFile(dir, agentId, "notes.md", "one\nfour\n", "Four");
      await expect(revertMemoryCommit(dir, agentId, three)).rejects.toThrow(/a later change touched the same lines/);
      expect(readFileSync(join(root, "notes.md"), "utf8")).toBe("one\nfour\n");
      expect(execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
      await expect(revertMemoryCommit(dir, agentId, "not-a-sha")).rejects.toThrow(/not a commit/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a review sees every file in full, up to its limit; past it, the rest by path and size", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-memory-"));
    try {
      const agentId = await createAgent(dir, { name: "Ada" });
      await editMemoryFile(dir, agentId, "reference/deploys.md", "Deploy on Fridays.\n");
      await editMemoryFile(dir, agentId, "reference/big.md", "x".repeat(500));
      const root = memoryRoot(dir, agentId);
      const all = memoryDump(root);
      expect(all.text).toContain('<file path="reference/deploys.md" chars="19">\nDeploy on Fridays.\n</file>');
      expect(all.text).toContain('<file path="system/persona.md"');
      const cut = memoryDump(root, 100);
      expect(cut.text).toContain("- reference/big.md (500 chars)");
      expect(cut.files).toBe(all.files);
      expect(memoryDump(join(dir, "nowhere"))).toEqual({ text: "", files: 0, chars: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a memory review deletes a file as the Doctor; the agent's own delete is the agent's", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-memory-"));
    try {
      const agentId = await createAgent(dir, { name: "Ada" });
      await editMemoryFile(dir, agentId, "old.md", "stale\n");
      await editMemoryFile(dir, agentId, "older.md", "staler\n");
      const faux = fauxProvider();
      const models = createModels();
      models.setProvider(faux.provider);
      const registry = createRegistry();
      registry.install(memoryExtension(dir));
      const store = await AgentStore.open({ storage: new MemoryStorage() }, { models, registry }, ctx);
      await store.setAgent({ id: agentId, name: "Ada" }, ctx);
      const model = { provider: faux.provider.id, modelId: faux.getModel().id };
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("memory_write", { path: "old.md", content: null, message: "Drop the stale note" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
        fauxAssistantMessage(fauxToolCall("memory_write", { path: "older.md", content: null }), { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
        fauxAssistantMessage(fauxToolCall("memory_search", { query: "kept" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("searched"),
      ]);
      await editMemoryFile(dir, agentId, "kept.md", "We kept deployment Fridays.\n");
      const doctor = await store.createChat(`doctor-${agentId}`, { hidden: true, agent: { model } }, ctx);
      await (await doctor.submit({ type: "input", content: "review" }, ctx)).wait(ctx);
      const mine = await store.createChat("c", { agent: { model } }, ctx);
      await (await mine.submit({ type: "input", content: "forget older" }, ctx)).wait(ctx);
      await (await mine.submit({ type: "input", content: "find kept" }, ctx)).wait(ctx);
      const root = memoryRoot(dir, agentId);
      expect(existsSync(join(root, "old.md")) || existsSync(join(root, "older.md"))).toBe(false);
      expect(log(root).slice(0, 2)).toEqual(["Ada|Remove older.md", "Doctor|Drop the stale note"]);
      const results = (await store.entries(mine, ctx)).filter((e) => e.kind === "pi.tool-result").map((e) => JSON.stringify(e.model));
      expect(results.at(-1)).toContain("kept.md");
      expect(results.at(-1)).toContain("deployment Fridays");
      await store.close(ctx);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("memoryDump prioritizes shared and system files, skips skills and binaries, and shows descriptions on overflow", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-memory-"));
    try {
      const agentId = await createAgent(dir, { name: "Ada" });
      const root = memoryRoot(dir, agentId);
      const sharedRoot = sharedMemoryRoot(dir);
      await editMemoryFile(dir, agentId, "shared/preferences.md", "Keep lists numbered.\n", "Add shared prefs");
      await editMemoryFile(dir, agentId, "reference/human/style.md", "---\ndescription: Read for tone rules\n---\nBe direct.\n", "Add human style");
      await editMemoryFile(dir, agentId, "reference/aaa-huge.md", `---\ndescription: Read when checking large estate\n---\n${"z".repeat(1200)}`, "Add huge");
      mkdirSync(join(root, "skills", "demo"), { recursive: true });
      writeFileSync(join(root, "skills", "demo", "SKILL.md"), "---\ndescription: demo skill\n---\nSkill body\n");
      writeFileSync(join(root, "profile.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));

      const cut = memoryDump(root, 400, sharedRoot);
      expect(cut.text).toContain('<file path="shared/preferences.md"');
      expect(cut.text).toContain('<file path="system/persona.md"');
      expect(cut.text).toContain('<file path="reference/human/style.md"');
      expect(cut.text).toContain("- reference/aaa-huge.md (1253 chars) — Read when checking large estate");
      expect(cut.text).not.toContain("skills/demo/SKILL.md");
      expect(cut.text).not.toContain("profile.png");
      expect(cut.files).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("memory_read paginates by line offset/limit, truncates past 40 KB, and refuses binary files; memory_search ranks multi-word queries across shared and agent notes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-memory-"));
    try {
      const agentId = await createAgent(dir, { name: "Ada" });
      const secondId = await createAgent(dir, { name: "Grace" });
      const root = memoryRoot(dir, agentId);
      await editMemoryFile(dir, agentId, "reference/numbered.md", ["line 1", "line 2", "line 3", "line 4", "line 5"].join("\n"), "Add lines");
      await editMemoryFile(dir, agentId, "reference/giant.md", `${"a".repeat(70_000)}\nsecond line\n`, "Add giant");
      await editMemoryFile(
        dir,
        agentId,
        "reference/workflow.md",
        "Always check current state before dev deploy.\nApproval covers the whole previewed batch.\n",
        "Add workflow",
      );
      writeFileSync(join(root, "profile.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));

      const faux = fauxProvider();
      const models = createModels();
      models.setProvider(faux.provider);
      const registry = createRegistry();
      registry.install(memoryExtension(dir));
      const store = await AgentStore.open({ storage: new MemoryStorage() }, { models, registry }, ctx);
      await store.setAgent({ id: agentId, name: "Ada" }, ctx);
      const chat = await store.createChat("c", { agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } } }, ctx);
      const model = { provider: faux.provider.id, modelId: faux.getModel().id };
      await chat.configure({ model }, ctx);

      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("memory_write", { path: "shared/prefs.md", content: "Never use em dashes.\n", message: "Shared rule" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage(fauxToolCall("memory_edit", { path: "shared/prefs.md", old_text: "em dashes", new_text: "filler" }), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxToolCall("memory_read", { path: "reference/numbered.md", offset: 2, limit: 2 }), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxToolCall("memory_read", { path: "reference/giant.md" }), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxToolCall("memory_read", { path: "profile.png" }), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxToolCall("memory_search", { query: "approval dev deploy" }), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxToolCall("memory_search", { query: "filler", path: "shared" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
      ]);
      await (await chat.submit({ type: "input", content: "test tools" }, ctx)).wait(ctx);

      const results = (await store.entries(chat, ctx)).filter((e) => e.kind === "pi.tool-result").map((e) => JSON.stringify(e.model));
      expect(results[2]).toContain("line 2\\nline 3");
      expect(results[2]).toContain("Showing lines 2–3 of 5 (reference/numbered.md). Pass offset=4 to read more.");
      expect(results[3]).toContain("Showing lines 1–1 of 3 (reference/giant.md). Pass offset=2 to read more.");
      expect(results[4]).toContain("is not a text file");
      expect(results[5]).toContain("reference/workflow.md");
      expect(results[6]).toContain("shared/prefs.md:1: Never use filler.");

      const secondSection = must(memorySection(memoryRoot(dir, secondId), "tools", sharedMemoryRoot(dir)), "second agent section");
      expect(secondSection).toContain('<file path="shared/prefs.md">\nNever use filler.\n</file>');
      expect(log(sharedMemoryRoot(dir))).toEqual(["Ada|Edit shared/prefs.md", "Ada|Shared rule"]);

      await editMemoryFile(dir, agentId, "shared/prefs.md", null, "Drop shared rule");
      expect(existsSync(join(sharedMemoryRoot(dir), "prefs.md"))).toBe(false);
      await store.close(ctx);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
