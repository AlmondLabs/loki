import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { createAgent } from "../daemon/store/agents.ts";
import { AgentStore } from "../daemon/kernel/index.ts";
import { editMemoryFile, memoryExtension, memoryRoot, memorySection } from "../daemon/memory.ts";

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
});
