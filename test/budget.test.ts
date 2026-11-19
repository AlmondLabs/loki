import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { BUDGETS, budgetFor, verdict } from "../scripts/budget.ts";

interface Job {
  "runs-on": string;
  steps: Array<{ run?: string }>;
}
const ci = parseYaml(readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "ci.yml"), "utf8")) as { jobs: Record<string, Job> };
const osOf = (runsOn: string) => (runsOn.startsWith("macos") ? "macOS" : runsOn.startsWith("windows") ? "Windows" : "Linux");

describe("each CI step's budget", () => {
  test("a step that passes within its budget passes, one past it fails with an annotation, and its own failure comes first", () => {
    expect(verdict("bun run lint", 0, 12, 40).code).toBe(0);
    const over = verdict("bun run lint", 0, 41.2, 40);
    expect(over.code).toBe(1);
    expect(over.message).toContain("::error title=Over its budget::bun run lint took 41.2s; its budget is 40s.");
    expect(verdict("bun run lint", 2, 41, 40)).toEqual({ code: 2, message: "bun run lint took 41.0s; its budget is 40s." });
  });

  test("a step with no budget on a system is an error, not a pass", () => {
    expect(() => budgetFor("bun run lint", "Windows")).toThrow("has no budget on Windows");
  });

  test("every check in ci.yml runs through the budget, with a budget for the system it runs on", () => {
    for (const [name, job] of Object.entries(ci.jobs))
      for (const s of job.steps) {
        // A step that only decides what runs (its answer to $GITHUB_OUTPUT) is not a check.
        if (!s.run || !/\bbun run\b/.test(s.run) || s.run.includes("$GITHUB_OUTPUT")) continue;
        expect(s.run, name).toMatch(/^bun run --silent budget /);
        // A step that picks its command with an expression (the selection on a PR) needs a budget for each.
        const commands = s.run.includes("${{") ? [...s.run.matchAll(/'(bun run [\w:]+)'/g)].map((m) => m[1]) : [s.run.replace("bun run --silent budget ", "")];
        for (const c of commands) expect(() => budgetFor(c, osOf(job["runs-on"])), `${name}: ${c}`).not.toThrow();
      }
  });

  test("setup has one on all three systems, held to it on a cache hit", () => {
    expect(Object.keys(BUDGETS.install).sort()).toEqual(["Linux", "Windows", "macOS"]);
    const action = readFileSync(join(import.meta.dirname, "..", ".github", "actions", "install", "action.yml"), "utf8");
    expect(action).toContain(`if: steps.cache.outputs.cache-hit == 'true'`);
    expect(action).toContain(`bun run --silent budget --took "$(( $(date +%s) - INSTALL_STARTED ))" install`);
  });
});
