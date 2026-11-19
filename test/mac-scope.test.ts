import { describe, expect, test } from "vitest";
import { needsMac } from "../scripts/mac-scope.ts";

const sources: Record<string, string> = {
  "test/card.test.ts": 'import { Card } from "../app/src/card.tsx";\nimport type { Frame } from "../core/frames.ts";',
  "test/watch.test.ts": 'import { watch } from "../mod/watch.ts";',
  "test/tokens.test.ts": 'readFileSync(join(import.meta.dirname, "..", "app"));',
  "test/spawn.test.ts": 'import { spawn } from "node:child_process";',
  "test/temp.test.ts": 'const dir = mkdtempSync(join(tmpdir(), "loki-"));',
};
const needs = (...paths: string[]) => needsMac(paths, (p) => sources[p]);

describe("whether a PR needs the Mac job", () => {
  test("not for the app, the site, docs, or a test of the app, one that reads the repository's files included", () => {
    expect(
      needs("app/src/card.tsx", "app/src/kit/tokens.css", "site/src/index.astro", "docs/manual.md", "README.md", "test/card.test.ts", "test/tokens.test.ts"),
    ).toBe(false);
  });

  test("a test the PR deleted needs nothing", () => {
    expect(needs("test/gone.test.ts")).toBe(false);
  });

  test("anything the daemon's side can see does: its code, its tests, scripts, fixtures, dependencies, workflows, configs", () => {
    for (const path of [
      "daemon/main.ts",
      "mod/watch.ts",
      "core/frames.ts",
      "scripts/smoke.ts",
      "test-node/peers.node-test.ts",
      "native/keychain.cc",
      "skills/loki/SKILL.md",
      "test/fixtures/fake-mcp.mjs",
      "test/watch.test.ts",
      "test/spawn.test.ts",
      "test/temp.test.ts",
      "bun.lock",
      ".github/workflows/ci.yml",
      "vitest.config.ts",
    ])
      expect(needs("app/src/card.tsx", path), path).toBe(true);
  });
});
