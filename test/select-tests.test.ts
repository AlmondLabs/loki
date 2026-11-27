import { describe, expect, test } from "vitest";
import { selectTests, treeReaders, vitestArgs } from "../scripts/select-tests.ts";

const tests = new Map([
  ["test/pure.test.ts", 'import { x } from "../core/x.ts";'],
  ["test/tokens.test.ts", 'const css = readFileSync(join(import.meta.dirname, "..", "app"), "utf8");'],
  ["test/build.test.ts", 'readFileSync(new URL("../scripts/build-mod.ts", import.meta.url));'],
]);

describe("which tests a PR runs", () => {
  test("TypeScript edits and additions under the code folders: those files, for vitest related, and every test that reads the tree", () => {
    const s = selectTests(
      [
        { status: "M", path: "core/x.ts" },
        { status: "A", path: "app/src/y.tsx" },
      ],
      tests,
    );
    expect(s).toEqual({ all: false, files: ["app/src/y.tsx", "core/x.ts", "test/build.test.ts", "test/tokens.test.ts"] });
  });

  test("docs and test fixture modules keep selection incremental", () => {
    const s = selectTests(
      [
        { status: "A", path: "docs/plans/2026-11-28-plan.md" },
        { status: "M", path: "docs/manual.md" },
        { status: "D", path: "docs/old.md" },
        { status: "M", path: "README.md" },
        { status: "M", path: "core/x.ts" },
        { status: "M", path: "test/fixtures/fake-mcp.mjs" },
      ],
      tests,
    );
    expect(s).toEqual({ all: false, files: ["core/x.ts", "test/build.test.ts", "test/fixtures/fake-mcp.mjs", "test/tokens.test.ts"] });
  });

  test("anything else runs the whole suite: a stylesheet, a config, the lockfile, a workflow, a deletion, a rename", () => {
    for (const change of [
      { status: "M", path: "app/src/kit/tokens.css" },
      { status: "M", path: "vitest.config.ts" },
      { status: "M", path: "bun.lock" },
      { status: "M", path: ".github/workflows/ci.yml" },
      { status: "D", path: "core/x.ts" },
      { status: "R", path: "core/y.ts" },
    ])
      expect(selectTests([{ status: "M", path: "core/x.ts" }, change], tests).all, change.path).toBe(true);
  });

  test("a test reads the tree when it names a path from its own folder or the working folder", () => {
    expect(treeReaders(tests)).toEqual(["test/tokens.test.ts", "test/build.test.ts"]);
    expect(treeReaders(new Map([["test/c.test.ts", "process.cwd()"]]))).toEqual(["test/c.test.ts"]);
  });
});

test("a shard flag reaches vitest whether the selection is everything or the files the diff reaches", () => {
  expect(vitestArgs({ all: true, why: "" }, ["--shard=1/2"])).toEqual(["run", "--shard=1/2"]);
  expect(vitestArgs({ all: false, files: ["test/a.test.ts"] }, ["--shard=2/2"])).toEqual([
    "related",
    "--run",
    "--passWithNoTests",
    "--shard=2/2",
    "test/a.test.ts",
  ]);
});
