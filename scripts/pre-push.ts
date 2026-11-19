import { execFileSync, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** One check the hook runs: a program and its arguments, run from the repository's root. */
export interface Check {
  name: string;
  bin: string;
  args: string[];
  // A Node script runs under this Node; anything else (bun) runs as itself.
  node: boolean;
}

const FORMATTED = /\.(c|m)?[jt]sx?$|\.(json|jsonc|css|ya?ml|toml)$/;
const SCRIPT = /\.(c|m)?[jt]sx?$/;

/**
 * The checks for a push that changes `files` (paths from the repository's root): format and lint on those files only,
 * and the typecheck on the whole project, since a change in one file can break the types of another and `bun check`
 * takes well under a second. Nothing to check gives an empty list.
 */
export function checksFor(files: readonly string[], binOf: (pkg: string, bin: string) => string): Check[] {
  const formatted = files.filter((f) => FORMATTED.test(f));
  const scripts = files.filter((f) => SCRIPT.test(f));
  const checks: Check[] = [];
  if (formatted.length)
    checks.push({ name: "format", bin: binOf("oxfmt", "bin/oxfmt"), args: ["--check", "--no-error-on-unmatched-pattern", ...formatted], node: true });
  if (scripts.length) {
    checks.push({ name: "oxlint", bin: binOf("oxlint", "bin/oxlint"), args: ["--no-error-on-unmatched-pattern", ...scripts], node: true });
    checks.push({ name: "eslint", bin: binOf("eslint", "bin/eslint.js"), args: ["--no-warn-ignored", ...scripts], node: true });
    checks.push({ name: "types", bin: binOf("bun", "bin/bun.exe"), args: ["check", "--no-script", "-p", "tsconfig.json"], node: false });
  }
  return checks;
}

/**
 * The files a push changes: everything that differs from where this branch left main, uncommitted edits included. A
 * clone without origin/main has no such point, so every tracked file is checked.
 */
export function changedFiles(git: (args: string[]) => string): string[] {
  let base: string;
  try {
    base = git(["merge-base", "HEAD", "origin/main"]).trim();
  } catch {
    return lines(git(["ls-files"]));
  }
  return lines(git(["diff", "--name-only", "--no-renames", "--diff-filter=d", base]));
}

const lines = (text: string) => text.split("\n").filter(Boolean);

interface Result {
  name: string;
  code: number;
  output: string;
  ms: number;
}

function run(check: Check, root: string): Promise<Result> {
  const start = performance.now();
  return new Promise((resolve) => {
    const [bin, args] = check.node ? [process.execPath, [check.bin, ...check.args]] : [check.bin, check.args];
    const child = spawn(bin, args, { cwd: root, env: { ...process.env, FORCE_COLOR: "1" } });
    let output = "";
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));
    const done = (code: number) => resolve({ name: check.name, code, output, ms: performance.now() - start });
    child.on("error", (e) => {
      output += e.message;
      done(1);
    });
    child.on("close", (code) => done(code ?? 1));
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const require = createRequire(import.meta.url);
  const binOf = (pkg: string, bin: string) => join(dirname(require.resolve(`${pkg}/package.json`)), bin);
  const files = changedFiles((args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }));
  const start = performance.now();
  // Side by side, each one's output held until it ends so they never interleave.
  const results = await Promise.all(checksFor(files, binOf).map((c) => run(c, root)));
  for (const r of results.filter((r) => r.code !== 0)) console.error(`\n✗ ${r.name}\n${r.output.trimEnd()}`);
  const summary = results.map((r) => `${r.code === 0 ? "✓" : "✗"} ${r.name} ${(r.ms / 1000).toFixed(1)}s`).join(", ");
  console.error(`pre-push: ${files.length} changed files; ${summary || "nothing to check"} (${((performance.now() - start) / 1000).toFixed(1)}s)`);
  if (results.some((r) => r.code !== 0)) {
    console.error("Fix these before pushing; `npm run format` fixes formatting.");
    process.exitCode = 1;
  }
}
