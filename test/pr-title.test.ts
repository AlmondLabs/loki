import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_TITLE, titleProblem } from "../scripts/check-pr-title.ts";
import { previewPr, releasePr } from "../scripts/release.ts";

/** A pull request's title is held to Conventional Commits (docs/style.md §9), since it becomes the merge commit. */
describe("PR titles", () => {
  test("type(scope): what changed passes, with or without a scope, breaking or not", () => {
    for (const title of [
      "feat(tasks): add task from a chat message",
      "fix(phone): pair over Tailscale",
      "ci: pin the windows runner",
      "refactor(core)!: drop the Letta wire names",
      'Revert "feat(tasks): add task from a chat message"',
    ])
      expect(titleProblem(title), title).toBeNull();
  });

  test("the rest is refused with what to change", () => {
    expect(titleProblem("Add task from a message")).toMatch(/type\(scope\): what changed/);
    expect(titleProblem("tasks: add task from a message")).toMatch(/"tasks" is not a type/);
    expect(titleProblem("feat(kitchen): a sink")).toMatch(/"kitchen" is not a scope/);
    expect(titleProblem("feat(tasks): Add task")).toMatch(/starts lowercase/);
    expect(titleProblem("feat(tasks): add task.")).toMatch(/full stop/);
    expect(titleProblem(`feat: ${"x".repeat(MAX_TITLE)}`)).toMatch(/at most/);
    expect(titleProblem("feat(tasks):missing space")).not.toBeNull();
  });

  test("the release workflow's own PRs pass", () => {
    expect(titleProblem(releasePr({ notes: "", mainSha: "abc", ifMergedNow: "2026.1016.0" }).title)).toBeNull();
    expect(titleProblem(previewPr("2026.1016.0", "AlmondLabs/loki").title)).toBeNull();
  });

  test("the workflow runs the check on every PR, the title passed through the environment", () => {
    const flow = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "pr-title.yml"), "utf8");
    expect(flow).toMatch(/types: \[opened, edited, reopened, synchronize\]/);
    expect(flow).toContain("PR_TITLE: ${{ github.event.pull_request.title }}");
    // Never interpolated into the shell line itself, where a title could run as a command.
    expect(flow).not.toMatch(/run:.*github\.event\.pull_request\.title/);
  });
});
