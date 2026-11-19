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
    expect(verdict("npm run lint", 0, 12, 40).code).toBe(0);
    const over = verdict("npm run lint", 0, 41.2, 40);
    expect(over.code).toBe(1);
    expect(over.message).toContain("::error title=Over its budget::npm run lint took 41.2s; its budget is 40s.");
    expect(verdict("npm run lint", 2, 41, 40)).toEqual({ code: 2, message: "npm run lint took 41.0s; its budget is 40s." });
  });

  test("a step with no budget on a system is an error, not a pass", () => {
    expect(() => budgetFor("npm run lint", "Windows")).toThrow("has no budget on Windows");
  });

  test("every check in ci.yml runs through the budget, with a budget for the system it runs on", () => {
    for (const [name, job] of Object.entries(ci.jobs))
      for (const s of job.steps) {
        if (!s.run || !/\bnpm (test|run)\b/.test(s.run)) continue;
        expect(s.run, name).toMatch(/^npm run -s budget -- /);
        const commands = s.run.includes("test:pr") ? ["npm run test:pr", "npm test"] : [s.run.replace("npm run -s budget -- ", "")];
        for (const c of commands) expect(() => budgetFor(c, osOf(job["runs-on"])), `${name}: ${c}`).not.toThrow();
      }
  });

  test("setup has one on all three systems, held to it on a cache hit", () => {
    expect(Object.keys(BUDGETS.install).sort()).toEqual(["Linux", "Windows", "macOS"]);
    const action = readFileSync(join(import.meta.dirname, "..", ".github", "actions", "install", "action.yml"), "utf8");
    expect(action).toContain(`if: steps.cache.outputs.cache-hit == 'true'`);
    expect(action).toContain(`npm run -s budget -- --took "$(( $(date +%s) - INSTALL_STARTED ))" install`);
  });
});
