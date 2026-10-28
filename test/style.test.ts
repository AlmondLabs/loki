import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * The parts of docs/style.md a test checks rather than a linter: how files are named (§2). Every file is kebab-case,
 * components and hooks included, and tools keep the config names they look for.
 */

const ROOT = join(import.meta.dirname, "..");
/** What the guide's naming covers: the TypeScript, JavaScript and CSS loki writes, outside the Rust shell and the docs. */
const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .filter((p) => /\.(tsx?|mts|mjs|css)$/.test(p) && !/^(src-tauri|docs|native|skills)\//.test(p) && existsSync(join(ROOT, p)));

/** What is wrong with a file's name, or null when it follows the guide. */
function nameProblem(path: string): string | null {
  const name = basename(path);
  if (/\.config\.(ts|mts|js|mjs)$/.test(name)) return null;
  const stem = name.replace(/(\.d)?(\.node-test|\.test)?\.(tsx?|mts|mjs|css)$/, "");
  if (path.startsWith("test/") && !path.startsWith("test/fixtures/") && !name.endsWith(".test.ts")) return "a test file ends in .test.ts";
  // test-node/ has no rule of its own: beside its .node-test.ts files sit the helpers they start or import, named like any module.
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(stem) ? null : "kebab-case, components and hooks included";
}

describe("file names (docs/style.md §2)", () => {
  test("the guide's naming covers the tree", () => {
    expect(files.length).toBeGreaterThan(300);
  });

  test("every file is named the guide's way", () => {
    const wrong = files.map((p) => [p, nameProblem(p)] as const).filter(([, problem]) => problem !== null);
    expect(wrong).toEqual([]);
  });

  test("the rule itself: what passes and what does not", () => {
    // These paths need not exist: only their names are judged.
    expect(nameProblem("app/src/shared/session-value.ts")).toBeNull();
    expect(nameProblem("app/src/chat/suggestion-card.tsx")).toBeNull();
    expect(nameProblem("app/src/chat/use-draft.ts")).toBeNull();
    expect(nameProblem("app/vite.config.ts")).toBeNull();
    expect(nameProblem("test/fixtures/fake-mcp.d.mts")).toBeNull();
    expect(nameProblem("test-node/crash-child.ts")).toBeNull();
    expect(nameProblem("app/src/shared/sessionValue.ts")).toMatch(/kebab-case/);
    expect(nameProblem("app/src/chat/SuggestionCard.tsx")).toMatch(/kebab-case/);
    expect(nameProblem("app/src/shell/useTasks.ts")).toMatch(/kebab-case/);
    expect(nameProblem("app/src/shell/Desk_Sidebar.css")).toMatch(/kebab-case/);
    expect(nameProblem("test/helpers.ts")).toMatch(/\.test\.ts/);
  });
});
