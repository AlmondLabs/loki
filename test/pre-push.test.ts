import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { changedFiles, checksFor } from "../scripts/pre-push.ts";

const binOf = (pkg: string, bin: string) => `${pkg}/${bin}`;
const names = (files: string[]) => checksFor(files, binOf).map((c) => c.name);

describe("the pre-push hook", () => {
  test("formats, lints and typechecks a push that changes code, linting only the changed files", () => {
    const checks = checksFor(["core/x.ts", "app/src/y.tsx", "docs/z.md"], binOf);
    expect(checks.map((c) => c.name)).toEqual(["format", "oxlint", "eslint", "types"]);
    expect(checks.find((c) => c.name === "oxlint")?.args).toEqual(["--no-error-on-unmatched-pattern", "core/x.ts", "app/src/y.tsx"]);
    // The types of one file can break in another, so the typecheck is the whole project's.
    expect(checks.find((c) => c.name === "types")).toEqual({
      name: "types",
      bin: "bun/bin/bun.exe",
      args: ["check", "--no-script", "-p", "tsconfig.json"],
      node: false,
    });
  });

  test("a push of a stylesheet or a config is only formatted, and a push of docs alone checks nothing", () => {
    expect(names(["app/src/kit/tokens.css", ".github/workflows/ci.yml"])).toEqual(["format"]);
    expect(names(["docs/manual.md", "app/public/icon.png"])).toEqual([]);
  });

  test("checks what differs from where the branch left main, or every file in a clone without origin/main", () => {
    const git = (args: string[]) => (args[0] === "merge-base" ? "abc\n" : args[0] === "diff" ? `a.ts\nb.ts\n` : "");
    expect(changedFiles(git)).toEqual(["a.ts", "b.ts"]);
    const noMain = (args: string[]) => {
      if (args[0] === "merge-base") throw new Error("no origin/main");
      return "x.ts\ny.css\n";
    };
    expect(changedFiles(noMain)).toEqual(["x.ts", "y.css"]);
  });

  test("bun install points git at the hook, which runs the script", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.prepare).toBe("git config core.hooksPath .githooks || exit 0");
    expect(readFileSync(join(import.meta.dirname, "..", ".githooks", "pre-push"), "utf8")).toContain("scripts/pre-push.ts");
  });
});
