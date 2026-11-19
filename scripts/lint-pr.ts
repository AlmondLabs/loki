import { spawn, execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { lintAll, linters, type Linter } from "./lint.ts";

/** One file a PR changed, as `git diff --name-status` gives it. */
export interface Change {
  status: string;
  path: string;
}

/** What a PR's lint covers: everything, and why, or these files. */
export type LintPlan = { all: true; why: string } | { all: false; files: string[] };

const SCRIPT = /\.(c|m)?[jt]sx?$/;
// A change to how the lint is set up, or to what the types are built from, can change any file's result.
const SETUP = /^(\.oxlintrc\.json|eslint\.config\.mjs|tsconfig(\.[\w-]+)?\.json|package\.json|bun\.lock|scripts\/lint(-pr)?\.ts)$/;
const IMPORT = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

const stem = (path: string) => path.replace(/\.(c|m)?[jt]sx?$/, "").replace(/\/index$/, "");

/** The files under `sources` that import one of `changed`, by relative path or the app's `@/` alias. */
export function importersOf(changed: ReadonlySet<string>, sources: ReadonlyMap<string, string>): string[] {
  const targets = new Set([...changed].map(stem));
  const found: string[] = [];
  for (const [file, text] of sources) {
    if (changed.has(file)) continue;
    for (const m of text.matchAll(IMPORT)) {
      const spec = m[1];
      const path = spec.startsWith("@/") ? `app/src/${spec.slice(2)}` : spec.startsWith(".") ? posix.join(posix.dirname(file), spec) : null;
      if (path !== null && targets.has(stem(path))) {
        found.push(file);
        break;
      }
    }
  }
  return found;
}

/**
 * On a PR, the files a change can turn red: the changed code and the files that import it directly. A type-aware rule
 * can still fail further away (a type two imports off), which the merge queue's full lint catches before main.
 */
export function lintPlan(changes: readonly Change[], sources: ReadonlyMap<string, string>): LintPlan {
  const setup = changes.find((c) => SETUP.test(c.path));
  if (setup) return { all: true, why: `${setup.path} changed` };
  const changed = new Set(changes.filter((c) => c.status !== "D" && SCRIPT.test(c.path)).map((c) => c.path));
  return { all: false, files: [...changed, ...importersOf(changed, sources)].sort() };
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function runNode(l: Linter, cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [l.bin, ...l.args], { cwd, stdio: "inherit" });
    child.on("error", () => resolve(1));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const args = process.argv.slice(2);
  const base = args.find((a) => !a.startsWith("--")) ?? "HEAD^1";
  const changes = git(["diff", "--name-status", "--no-renames", base, "HEAD"], root)
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status = "", path = ""] = line.split("\t");
      return { status: status.slice(0, 1), path };
    });
  const tracked = git(["ls-files"], root)
    .split("\n")
    .filter((f) => SCRIPT.test(f));
  const plan = lintPlan(changes, new Map(tracked.map((f) => [f, readFileSync(join(root, f), "utf8")])));
  // --plan says only whether the whole lint runs, for CI to pick the step and its budget (ci.yml).
  if (args.includes("--plan")) console.log(`all=${String(plan.all)}`);
  else if (plan.all) {
    console.log(`Linting everything: ${plan.why}.`);
    process.exitCode = await lintAll(linters([]), (l) => runNode(l, root));
  } else if (plan.files.length === 0) {
    console.log("No code changed: nothing to lint.");
  } else {
    console.log(`Linting the ${plan.files.length} files the diff reaches.`);
    process.exitCode = await lintAll(linters([], plan.files), (l) => runNode(l, root));
  }
}
