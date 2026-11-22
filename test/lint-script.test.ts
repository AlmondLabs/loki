import { describe, expect, test } from "vitest";
import { lintAll, linters, type Linter } from "../scripts/lint.ts";

describe("bun run lint", () => {
  test("runs oxlint, ESLint and the workflow comment check, and hands ESLint the extra arguments (lint:fast's cache)", () => {
    const list = linters(["--cache"]);
    expect(list.map((l) => l.name)).toEqual(["oxlint", "eslint", "workflows"]);
    expect(list[1]?.args).toContain("--cache");
    expect(list[0]?.args).toEqual([]);
  });

  test("given files, sends code to oxlint and ESLint and workflows to the workflow check, and skips a linter with nothing to check", () => {
    const both = linters([], ["core/a.ts", ".github/workflows/ci.yml"]);
    expect(both.map((l) => [l.name, l.args.at(-1)])).toEqual([
      ["oxlint", "core/a.ts"],
      ["eslint", "core/a.ts"],
      ["workflows", ".github/workflows/ci.yml"],
    ]);
    expect(linters([], [".github/workflows/ci.yml"]).map((l) => l.name)).toEqual(["workflows"]);
    expect(linters([], ["core/a.ts"]).map((l) => l.name)).toEqual(["oxlint", "eslint"]);
  });

  test("starts every linter before any ends, and fails when one fails", async () => {
    const started: string[] = [];
    const finish = new Map<string, (code: number) => void>();
    const run = (l: Linter) => new Promise<number>((resolve) => (finish.set(l.name, resolve), started.push(l.name)));
    const list = linters([]);
    const done = lintAll(list, run);
    expect(started).toEqual(["oxlint", "eslint", "workflows"]);
    finish.get("oxlint")?.(0);
    finish.get("eslint")?.(1);
    finish.get("workflows")?.(0);
    expect(await done).toBe(1);
    expect(await lintAll(list, () => Promise.resolve(0))).toBe(0);
  });
});
