import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isReflectionCommit, readReflectionConversations, reflectionState } from "../mod/reflection.ts";
import type { MemoryCommit } from "../mod/agents.ts";

const AGENT = "agent-local-11111111-2222-3333-4444-555555555555";
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "loki-reflection-"));
  const conv = (id: string, state: Record<string, unknown>) => {
    mkdirSync(join(root, AGENT, id), { recursive: true });
    writeFileSync(join(root, AGENT, id, "state.json"), JSON.stringify(state));
  };
  conv("c-quiet", { total_completed_steps: 30, reflected_completed_steps: 25, steps_since_last_successful_reflection: 5, last_reflection_started_at: "2026-09-12T17:30:54.000Z", last_reflection_succeeded_at: "2026-09-12T17:31:31.000Z" });
  conv("c-near", { total_completed_steps: 49, reflected_completed_steps: 25, steps_since_last_successful_reflection: 24, last_reflection_started_at: "2026-09-12T18:34:30.000Z", last_reflection_succeeded_at: "2026-09-12T18:35:12.000Z" });
  conv("c-new", { total_completed_steps: 20, reflected_completed_steps: 0, steps_since_last_successful_reflection: 20 });
  mkdirSync(join(root, AGENT, "c-broken"), { recursive: true });
  writeFileSync(join(root, AGENT, "c-broken", "state.json"), "{ not json");
  writeFileSync(join(root, AGENT, "stray-file"), "x");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("reflection state (Letta's transcript state files)", () => {
  test("every conversation with a readable state file, nearest the next pass first; titles looked up; junk skipped", () => {
    const rows = readReflectionConversations(AGENT, (id) => (id === "c-near" ? "aws estate" : null), root);
    expect(rows.map((r) => r.conversationId)).toEqual(["c-near", "c-new", "c-quiet"]);
    expect(rows[0]).toEqual({ conversationId: "c-near", title: "aws estate", stepsSince: 24, totalSteps: 49, lastStartedAt: "2026-09-12T18:34:30.000Z", lastSucceededAt: "2026-09-12T18:35:12.000Z" });
    expect(rows[1].lastSucceededAt).toBeNull(); // never reflected
  });
  test("an agent without a folder, or a bad id, is empty", () => {
    expect(readReflectionConversations("agent-local-nobody", () => null, root)).toEqual([]);
    expect(readReflectionConversations("../etc", () => null, root)).toEqual([]);
  });
  test("the last commit a pass made is the newest one by the Reflection Subagent; none means null", async () => {
    const commits: MemoryCommit[] = [
      { sha: "a1", message: "aws-estate: nomenclature scan", at: "2026-09-12T18:12:01Z", files: ["reference/aws.md"], author: "friday" },
      { sha: "b2", message: "fix(reflection): reverse the settled no 🔮", at: "2026-09-09T15:55:02Z", files: ["reference/aws.md"], author: "Reflection Subagent" },
      { sha: "c3", message: "feat(reflection): capture the estate", at: "2026-09-09T08:38:36Z", files: ["reference/aws.md"], author: "Reflection Subagent" },
    ];
    expect(isReflectionCommit(commits[0])).toBe(false);
    const s = await reflectionState(AGENT, () => null, { root, log: async () => commits });
    expect(s.lastCommit?.sha).toBe("b2");
    expect(s.conversations).toHaveLength(3);
    const none = await reflectionState(AGENT, () => null, { root, log: async () => [commits[0]] });
    expect(none.lastCommit).toBeNull();
    const failing = await reflectionState(AGENT, () => null, { root, log: async () => Promise.reject(new Error("no repo")) });
    expect(failing.lastCommit).toBeNull();
  });
});
