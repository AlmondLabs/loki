import { describe, expect, test } from "vitest";
import { importersOf, lintPlan } from "../scripts/lint-pr.ts";

const sources = new Map([
  ["core/a.ts", "export const a = 1;"],
  ["core/b.ts", 'import { a } from "./a.ts";'],
  ["daemon/c.ts", 'import { b } from "../core/b.ts";'],
  ["app/src/d.tsx", 'import { a } from "../../core/a";\nconst lazy = import("./e.tsx");'],
  ["app/src/e.tsx", 'import { x } from "@/kit/index.tsx";'],
  ["app/src/kit/index.tsx", "export const x = 1;"],
  ["mod/f.ts", 'import { a } from "node:fs";'],
]);

describe("a PR's lint", () => {
  test("lints the changed code and the files that import it directly; a file two imports away is left to the merge queue", () => {
    expect(lintPlan([{ status: "M", path: "core/a.ts" }], sources)).toEqual({ all: false, files: ["app/src/d.tsx", "core/a.ts", "core/b.ts"] });
  });

  test("follows the app's @/ alias, a folder's index file and a dynamic import", () => {
    expect(importersOf(new Set(["app/src/kit/index.tsx"]), sources)).toEqual(["app/src/e.tsx"]);
    expect(importersOf(new Set(["app/src/e.tsx"]), sources)).toEqual(["app/src/d.tsx"]);
  });

  test("a deleted file and a file that is not code are not linted, and a PR of docs alone lints nothing", () => {
    expect(
      lintPlan(
        [
          { status: "D", path: "core/a.ts" },
          { status: "M", path: "docs/manual.md" },
          { status: "M", path: "app/src/kit/tokens.css" },
        ],
        sources,
      ),
    ).toEqual({ all: false, files: [] });
  });

  test("a changed workflow is linted for its comments", () => {
    expect(lintPlan([{ status: "M", path: ".github/workflows/ci.yml" }], sources)).toEqual({ all: false, files: [".github/workflows/ci.yml"] });
  });

  test("lints everything when the lint's setup or what the types are built from changes", () => {
    for (const path of [
      ".oxlintrc.json",
      "eslint.config.mjs",
      "tsconfig.json",
      "package.json",
      "bun.lock",
      "scripts/lint.ts",
      "scripts/lint-pr.ts",
      "eslint-comments.mjs",
      "scripts/workflow-comments.ts",
    ])
      expect(
        lintPlan(
          [
            { status: "M", path: "core/a.ts" },
            { status: "M", path },
          ],
          sources,
        ),
        path,
      ).toEqual({ all: true, why: `${path} changed` });
  });
});
