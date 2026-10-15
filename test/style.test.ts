import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * The parts of docs/STYLE.md a test checks rather than a linter: how files are named (§2). A component's file is
 * PascalCase and exports that component, a hook's file is useX, everything else is kebab-case, and tools keep the
 * config names they look for.
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
  if (name.endsWith(".tsx") && /^[A-Z][A-Za-z0-9]*$/.test(stem)) {
    const source = readFileSync(join(ROOT, path), "utf8");
    return new RegExp(`export (async )?(function|const|class) ${stem}\\b`).test(source) ? null : `a PascalCase file exports the component it is named after (${stem})`;
  }
  if (/^use[A-Z][A-Za-z0-9]*$/.test(stem)) return /\.tsx?$/.test(name) ? null : "a hook's file is .ts or .tsx";
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(stem) ? null : "kebab-case (components PascalCase, hooks useX)";
}

describe("file names (docs/STYLE.md §2)", () => {
  test("the guide's naming covers the tree", () => {
    expect(files.length).toBeGreaterThan(300);
  });

  test("every file is named the guide's way", () => {
    const wrong = files.map((p) => [p, nameProblem(p)] as const).filter(([, problem]) => problem !== null);
    expect(wrong).toEqual([]);
  });

  test("the rule itself: what passes and what does not", () => {
    // These paths need not exist; only their names are judged, except a PascalCase file, whose export is read.
    expect(nameProblem("app/src/shared/session-value.ts")).toBeNull();
    expect(nameProblem("app/src/shell/useTasks.ts")).toBeNull();
    expect(nameProblem("app/vite.config.ts")).toBeNull();
    expect(nameProblem("test/fixtures/fake-mcp.d.mts")).toBeNull();
    expect(nameProblem("app/src/shared/sessionValue.ts")).toMatch(/kebab-case/);
    expect(nameProblem("app/src/shell/Desk_Sidebar.css")).toMatch(/kebab-case/);
    expect(nameProblem("test/helpers.ts")).toMatch(/\.test\.ts/);
    expect(nameProblem("test-node/crash-child.ts")).toBeNull();
    expect(nameProblem("app/src/tasks/TasksPane.tsx")).toBeNull();
  });
});
