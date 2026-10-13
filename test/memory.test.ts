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
import { editMemoryFile, memoryDump, memoryExtension, memoryRoot, memorySection, revertMemoryCommit } from "../daemon/memory.ts";

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
      const text = memorySection(root)!;
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
      const text = memorySection(root)!;
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
        reply(fauxAssistantMessage(fauxToolCall("memory_write", { path: "system/human.md", content: "Likes tea.\n", message: "Note the tea" }), { stopReason: "toolUse" })),
        reply(fauxAssistantMessage(fauxToolCall("memory_edit", { path: "system/human.md", old_text: "tea", new_text: "green tea" }), { stopReason: "toolUse" })),
        reply(fauxAssistantMessage(fauxToolCall("memory_read", { path: "../../etc/passwd" }), { stopReason: "toolUse" })),
        reply(fauxAssistantMessage("noted")),
      ]);
      await (await chat.submit({ type: "input", content: "I like tea" }, ctx)).wait(ctx);
      const root = memoryRoot(dir, agentId);
      expect(readFileSync(join(root, "system", "human.md"), "utf8")).toBe("Likes green tea.\n");
      expect(log(root)).toEqual(["Ada|Edit system/human.md", "Ada|Note the tea", "Ada|Begin memory"]);
      expect(sent[0]).toContain("I am Ada.");
      expect(sent[2]).toContain("Likes green tea."); // the section after the edit
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
      for (const path of [".git/config", ".GIT/config", ".Git/hooks/pre-commit", "notes/.git/config", ".gitattributes", "notes/.GitAttributes", ".gitmodules", "../outside.md"])
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
      // An older change whose lines a later one rewrote cannot be taken out on its own.
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
        fauxAssistantMessage(fauxToolCall("memory_delete", { path: "old.md", message: "Drop the stale note" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
        fauxAssistantMessage(fauxToolCall("memory_delete", { path: "older.md" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
      ]);
      const doctor = await store.createChat(`doctor-${agentId}`, { hidden: true, agent: { model } }, ctx);
      await (await doctor.submit({ type: "input", content: "review" }, ctx)).wait(ctx);
      const mine = await store.createChat("c", { agent: { model } }, ctx);
      await (await mine.submit({ type: "input", content: "forget older" }, ctx)).wait(ctx);
      const root = memoryRoot(dir, agentId);
      expect(existsSync(join(root, "old.md")) || existsSync(join(root, "older.md"))).toBe(false);
      expect(log(root).slice(0, 2)).toEqual(["Ada|Remove older.md", "Doctor|Drop the stale note"]);
      await store.close(ctx);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
