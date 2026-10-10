import { describe, expect, test } from "vitest";
import { isReflectionCommit, reflectionState } from "../mod/reflection.ts";
import type { MemoryCommit } from "../core/frame-types.ts";

const AGENT = "agent-local-11111111-2222-3333-4444-555555555555";

describe("reflection state", () => {
  test("the last commit a pass made is the newest one by Reflection; none means null", async () => {
    const commits: MemoryCommit[] = [
      { sha: "a1", message: "aws-estate: nomenclature scan", at: "2026-09-12T18:12:01Z", files: ["reference/aws.md"], author: "friday" },
      { sha: "b2", message: "fix(reflection): reverse the settled no 🔮", at: "2026-09-09T15:55:02Z", files: ["reference/aws.md"], author: "Reflection Subagent" },
      { sha: "c3", message: "feat(reflection): capture the estate", at: "2026-09-09T08:38:36Z", files: ["reference/aws.md"], author: "Reflection" },
    ];
    expect(isReflectionCommit(commits[0])).toBe(false);
    expect((await reflectionState(AGENT, { log: async () => commits })).lastCommit?.sha).toBe("b2");
    expect((await reflectionState(AGENT, { log: async () => [commits[0]] })).lastCommit).toBeNull();
    expect((await reflectionState(AGENT, { log: async () => Promise.reject(new Error("no repo")) })).lastCommit).toBeNull();
  });
});
