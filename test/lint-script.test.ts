import { describe, expect, test } from "vitest";
import { lintAll, linters, type Linter } from "../scripts/lint.ts";

describe("bun run lint", () => {
  test("runs oxlint and ESLint, and hands ESLint the extra arguments (lint:fast's cache)", () => {
    const list = linters(["--cache"]);
    expect(list.map((l) => l.name)).toEqual(["oxlint", "eslint"]);
    expect(list[1]?.args).toContain("--cache");
    expect(list[0]?.args).toEqual([]);
  });

  test("starts both before either ends, and fails when either fails", async () => {
    const started: string[] = [];
    const finish = new Map<string, (code: number) => void>();
    const run = (l: Linter) => new Promise<number>((resolve) => (finish.set(l.name, resolve), started.push(l.name)));
    const list = linters([]);
    const done = lintAll(list, run);
    expect(started).toEqual(["oxlint", "eslint"]);
    finish.get("oxlint")?.(0);
    finish.get("eslint")?.(1);
    expect(await done).toBe(1);
    expect(await lintAll(list, () => Promise.resolve(0))).toBe(0);
  });
});
