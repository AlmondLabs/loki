import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, listAgents, writeRecord } from "../daemon/store/agents.ts";
import { memoryTree, readLocalAgent } from "../mod/agents.ts";

describe("daemon agents", () => {
  test("a new agent has a record the mod reads and a memory repo with its first commit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-agents-"));
    try {
      const id = await createAgent(dir, { name: "Ada", description: "A careful helper.", model: "openrouter/~anthropic/claude-haiku-latest" });
      expect(id).toMatch(/^agent-local-[0-9a-f-]{36}$/);
      expect(readLocalAgent(id, dir)).toMatchObject({ id, name: "Ada", description: "A careful helper.", model: "openrouter/~anthropic/claude-haiku-latest", tags: ["origin:loki"] });
      expect(memoryTree(id, dir).map((f) => f.path)).toContain("system/persona.md");
      const log = execFileSync("git", ["-C", join(dir, "memfs", id, "memory"), "log", "--format=%an|%s"], { encoding: "utf8" }).trim();
      expect(log).toBe("Ada|Begin memory");
      expect(listAgents(dir)).toEqual([id]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("helper agents and memory folders without a record are not the person's agents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-agents-"));
    try {
      const mine = await createAgent(dir, { name: "Mine" });
      const helper = "agent-local-00000000-0000-0000-0000-000000000001";
      mkdirSync(join(dir, "memfs", helper, "memory"), { recursive: true });
      writeRecord(dir, helper, { id: helper, name: "Letta Code", tags: ["role:subagent"] });
      mkdirSync(join(dir, "memfs", "agent-local-00000000-0000-0000-0000-000000000002", "memory"), { recursive: true });
      expect(listAgents(dir)).toEqual([mine]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no backend folder yet: no agents", () => {
    expect(listAgents(join(tmpdir(), "loki-agents-none-here"))).toEqual([]);
  });
});
