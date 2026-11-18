import { describe, expect, test } from "vitest";
import { selectTests, treeReaders } from "../scripts/select-tests.ts";

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

  test("anything else runs the whole suite: a stylesheet, a config, the lockfile, a workflow, a doc, a deletion, a rename", () => {
    for (const change of [
      { status: "M", path: "app/src/kit/tokens.css" },
      { status: "M", path: "vitest.config.ts" },
      { status: "M", path: "package-lock.json" },
      { status: "M", path: ".github/workflows/ci.yml" },
      { status: "M", path: "docs/design.md" },
      { status: "M", path: "test/fixtures/fake-mcp.mjs" },
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
