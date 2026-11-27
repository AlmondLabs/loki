import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Change {
  status: string;
  path: string;
}

export type Selection = { all: true; why: string } | { all: false; files: string[] };

const CODE = /^(app\/src|mod|core|daemon|desktop|site\/src|scripts|test|test-node)\/.+\.(ts|tsx|mts|mjs)$/;
const DOCS = /^(docs\/|LICENSE$|\.github\/ISSUE_TEMPLATE\/|[^/]+\.md$)/;
// Outside (vitest): `vitest related` follows the module graph, which cannot see a test that reads the tree from disk,
// so such a test runs on every PR.
const READS_TREE = /import\.meta\.dirname|new URL\(\s*["'`]\.\.\/|process\.cwd\(\)/;

export function treeReaders(tests: ReadonlyMap<string, string>): string[] {
  return [...tests].filter(([, source]) => READS_TREE.test(source)).map(([path]) => path);
}

export function selectTests(changes: readonly Change[], tests: ReadonlyMap<string, string>): Selection {
  const codeChanges: Change[] = [];
  for (const c of changes) {
    if (DOCS.test(c.path)) continue;
    if (c.status !== "M" && c.status !== "A") return { all: true, why: `${c.path} was ${c.status === "D" ? "deleted" : "renamed or copied"}` };
    if (!CODE.test(c.path)) return { all: true, why: `${c.path} is not TypeScript or a test fixture module` };
    codeChanges.push(c);
  }
  return { all: false, files: [...new Set([...codeChanges.map((c) => c.path), ...treeReaders(tests)])].sort() };
}

export function vitestArgs(selection: Selection, flags: readonly string[]): string[] {
  return selection.all ? ["run", ...flags] : ["related", "--run", "--passWithNoTests", ...flags, ...selection.files];
}

function changesSince(base: string): Change[] {
  const out = execFileSync("git", ["diff", "--name-status", "--no-renames", base, "HEAD"], { encoding: "utf8" });
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status = "", path = ""] = line.split("\t");
      return { status: status.slice(0, 1), path };
    });
}

function testSources(root: string): Map<string, string> {
  const dir = join(root, "test");
  return new Map(
    readdirSync(dir)
      .filter((n) => n.endsWith(".test.ts"))
      .map((n) => [`test/${n}`, readFileSync(join(dir, n), "utf8")]),
  );
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const given = process.argv.slice(2);
  const base = given.find((a) => !a.startsWith("--")) ?? "HEAD^1";
  const flags = given.filter((a) => a.startsWith("--"));
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const selection = selectTests(changesSince(base), testSources(root));
  const vitest = join(dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs");
  const args = vitestArgs(selection, flags);
  console.log(selection.all ? `All tests: ${selection.why}.` : `Tests the diff reaches, from ${selection.files.length} files and tree readers.`);
  process.exitCode = spawnSync(process.execPath, [vitest, ...args], { stdio: "inherit", cwd: root }).status ?? 1;
}
