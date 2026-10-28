import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentPrompt } from "../daemon/acp/prompt.ts";
import { memoryRoot, memorySection } from "../daemon/memory.ts";
import { createAgent } from "../daemon/store/agents.ts";
import { must } from "./fixtures/must.ts";

describe("an agent's prompt for an ACP agent (plan 020, KD5)", () => {
  test("who it is, its memory with the rest by full path and not to edit, and its skills by path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-acp-prompt-"));
    const globalSkills = join(dir, "global-skills");
    try {
      const id = await createAgent(dir, { name: "Ada", persona: "I keep the garden notes." });
      const root = memoryRoot(dir, id);
      mkdirSync(join(root, "notes"), { recursive: true });
      writeFileSync(join(root, "notes", "roses.md"), "prune in March\n");
      mkdirSync(join(root, "skills", "pruning"), { recursive: true });
      writeFileSync(join(root, "skills", "pruning", "SKILL.md"), "---\nname: pruning\ndescription: how to prune roses\n---\nCut above a bud.\n");
      const prompt = must(agentPrompt(dir, id, "Ada", false, globalSkills));
      expect(prompt).toMatch(/^You are Ada, an agent of theirs in loki/);
      expect(prompt).toContain("I keep the garden notes.");
      expect(prompt).toContain(`- ${join(root, "notes", "roses.md")}`);
      expect(prompt).toContain("do not edit them");
      expect(prompt).not.toContain("memory_read");
      expect(prompt).toContain(`- pruning: how to prune roses (${join(root, "skills", "pruning", "SKILL.md")})`);
      // loki's own chats keep the memory tools' wording.
      expect(memorySection(root)).toContain("read one with memory_read");
      expect(agentPrompt(dir, "agent-nobody", null, false, globalSkills)).toBeNull();
      // With loki's tools (plan 044), the memory is changed through them, as in loki's own chats.
      const withTools = must(agentPrompt(dir, id, "Ada", true, globalSkills));
      expect(withTools).toContain("mcp__loki__memory_read");
      expect(withTools).toContain("never by editing the files");
      expect(withTools).toContain("read one with memory_read");
      expect(withTools).not.toContain("do not edit them");
      // Suggestions (plan 047, KTD5): an ACP agent never sees the mod's prompt sections, so the prompt names the tool.
      expect(withTools).toContain("suggestion_create");
      expect(prompt).not.toContain("suggestion_create");
      // An agent with no memory and no skills still learns of the tool when loki's tools reach it.
      expect(agentPrompt(dir, "agent-nobody", null, true, globalSkills)).toContain("suggestion_create");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
