import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BUDGET, coreSize, memorySection } from "../daemon/memory.ts";
import { overBudget, reflectionJob } from "../daemon/reflection.ts";
import { briefDescription } from "../mod/skills.ts";
import { must } from "./fixtures/must.ts";

/** A memory repo with the files given, path to text; removed after the test body. */
function withMemory(files: Record<string, string>, body: (root: string) => void | Promise<void>) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "loki-disclosure-"));
    try {
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(join(root, path, ".."), { recursive: true });
        writeFileSync(join(root, path), text);
      }
      await body(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

describe("memory beyond the core is listed by when to read it (plan 034)", () => {
  test(
    "a note is listed with its description, else its first heading, else its path; skills are left out",
    withMemory(
      {
        "system/persona.md": "I am careful.\n",
        "gotchas/commands.md": "---\ndescription: commands on this Mac — python3, not python\n---\nUse python3.\n",
        "projects/garden.md": "# The garden project\n\nRoses.\n",
        "reference/plain.md": "just text",
        "reference/long.md": `---\ndescription: ${"w ".repeat(400)}\n---\nlong\n`,
        "skills/pruning/SKILL.md": "---\nname: pruning\ndescription: how to prune\n---\nCut.\n",
      },
      (root) => {
        const text = must(memorySection(root), "the memory section");
        expect(text).toContain("- gotchas/commands.md — commands on this Mac — python3, not python");
        expect(text).toContain("- projects/garden.md — The garden project");
        expect(text).toMatch(/^- reference\/plain\.md$/m);
        expect(text).not.toContain("Use python3.");
        expect(text).not.toContain("skills/pruning");
        expect(text).toMatch(/^- reference\/long\.md — w(?: w)*…$/m);
      },
    ),
  );

  test(
    "the core is measured by its files, biggest first",
    withMemory({ "system/a.md": "x".repeat(300), "system/b.md": "x".repeat(900), "notes/c.md": "x".repeat(5000) }, (root) => {
      expect(coreSize(root)).toEqual({
        bytes: 1200,
        files: [
          { path: "system/b.md", bytes: 900 },
          { path: "system/a.md", bytes: 300 },
        ],
      });
      expect(coreSize(join(root, "nope"))).toBeUndefined();
    }),
  );
});

describe("reflection keeps the core within its budget", () => {
  const input = (memoryRoot: string) => ({ agentId: "agent-local-a", agentName: "Ada", memoryRoot, parts: [], material: "you: hi", now: new Date(0) });

  test(
    "within the budget, reflection is not asked to move anything",
    withMemory({ "system/persona.md": "x".repeat(CORE_BUDGET) }, async (root) => {
      expect(overBudget(root)).toBeNull();
      expect(await reflectionJob.prompt(input(root))).not.toContain("over their budget");
    }),
  );

  test(
    "over it, the prompt names the size and the biggest notes",
    withMemory({ "system/persona.md": "x".repeat(2048), "system/gotchas.md": "x".repeat(CORE_BUDGET) }, async (root) => {
      const prompt = must(await reflectionJob.prompt(input(root)), "the prompt");
      expect(prompt).toContain("come to 14 KB, over their budget of 12 KB");
      expect(prompt.indexOf("- system/gotchas.md (12 KB)")).toBeLessThan(prompt.indexOf("- system/persona.md (2 KB)"));
    }),
  );
});

describe("skills are listed with a short description", () => {
  test("a short description is left whole", () => {
    expect(briefDescription("How to prune roses.")).toBe("How to prune roses.");
  });

  test("a long one is cut at a word to 200 characters, keeping what comes after its first sentence", () => {
    const long = `Prune roses. Use when the person asks about the garden, ${"and more words ".repeat(20)}`;
    const brief = briefDescription(long);
    expect(brief.length).toBeLessThanOrEqual(200);
    expect(brief).toMatch(/^Prune roses\. Use when the person asks about the garden, and more/);
    expect(brief.endsWith("words…") || brief.endsWith("more…") || brief.endsWith("and…")).toBe(true);
  });
});
