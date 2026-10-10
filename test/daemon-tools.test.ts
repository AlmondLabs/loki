import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { AgentStore } from "../daemon/kernel/index.ts";
import { fileToolsExtension } from "../daemon/tools.ts";
import { skillsExtension, skillsOf } from "../daemon/skills.ts";
import { subagentExtension } from "../daemon/subagents.ts";
import { createAgent } from "../daemon/store/agents.ts";
import { memoryRoot } from "../daemon/memory.ts";

const ctx = BACKGROUND_CONTEXT;

/** A chat in `cwd` on a store with the given extensions; returns what each request sent and each tool result. */
async function chatWith(cwd: string, extensions: ReturnType<typeof fileToolsExtension>[], agent?: { id: string; name: string }) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  for (const e of extensions) registry.install(e);
  const store = await AgentStore.open({ storage: new MemoryStorage() }, { models, registry }, ctx);
  if (agent) await store.setAgent(agent, ctx);
  const chat = await store.createChat("c", { agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id }, cwd } }, ctx);
  const sent: string[] = [];
  const reply = (m: ReturnType<typeof fauxAssistantMessage>) => (c: { systemPrompt?: string; messages: unknown[] }) => (sent.push(JSON.stringify(c)), m);
  const results = async () => (await store.entries(chat, ctx)).filter((e) => e.kind === "pi.tool-result").map((e) => JSON.stringify(e.model));
  return { faux, store, chat, sent, reply, results };
}

describe("file tools", () => {
  test("ls, find and grep work in the chat's folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-tools-"));
    try {
      mkdirSync(join(dir, "src"));
      mkdirSync(join(dir, "node_modules"));
      writeFileSync(join(dir, "src", "a.ts"), "export const answer = 42;\n");
      writeFileSync(join(dir, "README.md"), "# hello\n");
      writeFileSync(join(dir, "node_modules", "x.ts"), "answer");
      const t = await chatWith(dir, [fileToolsExtension()]);
      t.faux.setResponses([
        t.reply(fauxAssistantMessage([fauxToolCall("ls", {}), fauxToolCall("find", { pattern: "**/*.ts" }), fauxToolCall("grep", { pattern: "answer" })], { stopReason: "toolUse" })),
        t.reply(fauxAssistantMessage("seen")),
      ]);
      await (await t.chat.submit({ type: "input", content: "look" }, ctx)).wait(ctx);
      const [ls, find, grep] = await t.results();
      expect(ls).toContain("README.md\\nsrc/");
      expect(find).toContain("src/a.ts");
      expect(find).not.toContain("node_modules");
      expect(grep).toContain("a.ts:1:export const answer = 42;");
      expect(grep).not.toContain("node_modules");
      await t.store.close(ctx);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("skills and project instructions", () => {
  test("the agent's own skills and the global ones are listed; Skill loads one; the folder's AGENTS.md is a section", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-skills-"));
    try {
      const agentId = await createAgent(dir, { name: "Ada" });
      const own = join(memoryRoot(dir, agentId), "skills", "tea");
      mkdirSync(own, { recursive: true });
      writeFileSync(join(own, "SKILL.md"), "---\ndescription: brew tea properly\n---\n# Tea\nSteep three minutes.\n");
      const shared = join(dir, "shared", "unslop");
      mkdirSync(shared, { recursive: true });
      writeFileSync(join(shared, "SKILL.md"), "---\ndescription: write plainly\n---\n");
      const globalDir = join(dir, "global");
      mkdirSync(globalDir);
      symlinkSync(shared, join(globalDir, "unslop"));
      const project = join(dir, "project");
      mkdirSync(project);
      writeFileSync(join(project, "AGENTS.md"), "Use bun, never npm.\n");
      expect(skillsOf(dir, agentId, globalDir).map((s) => [s.name, s.description])).toEqual([["tea", "brew tea properly"], ["unslop", "write plainly"]]);
      const t = await chatWith(project, [skillsExtension(dir, globalDir)], { id: agentId, name: "Ada" });
      t.faux.setResponses([t.reply(fauxAssistantMessage(fauxToolCall("Skill", { skill: "tea" }), { stopReason: "toolUse" })), t.reply(fauxAssistantMessage("ok"))]);
      await (await t.chat.submit({ type: "input", content: "tea please" }, ctx)).wait(ctx);
      expect(t.sent[0]).toContain("- tea: brew tea properly");
      expect(t.sent[0]).toContain("- unslop: write plainly");
      expect(t.sent[0]).toContain("Use bun, never npm.");
      expect((await t.results())[0]).toContain('<skill_content name=\\"tea\\">');
      expect((await t.results())[0]).toContain("Steep three minutes.");
      await t.store.close(ctx);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("subagents", () => {
  test("a helper runs the task in its own conversation and its final answer comes back; it cannot start helpers itself", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-sub-"));
    try {
      const t = await chatWith(dir, [subagentExtension()]);
      t.faux.setResponses([
        t.reply(fauxAssistantMessage(fauxToolCall("Agent", { description: "count", prompt: "Count to three." }), { stopReason: "toolUse" })),
        t.reply(fauxAssistantMessage("one, two, three")), // the helper
        t.reply(fauxAssistantMessage("The helper counted.")),
      ]);
      await (await t.chat.submit({ type: "input", content: "delegate" }, ctx)).wait(ctx);
      expect((await t.results())[0]).toContain("one, two, three");
      // The helper's request offered no Agent tool.
      expect(t.sent[0]).toContain('"name":"Agent"');
      expect(t.sent[1]).toContain("Count to three.");
      expect(t.sent[1]).not.toContain('"name":"Agent"');
      expect(t.sent[1]).not.toContain("delegate");
      await t.store.close(ctx);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
