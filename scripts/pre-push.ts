import { execFileSync, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WORKFLOW_FILE } from "./lint.ts";

export interface Check {
  name: string;
  bin: string;
  args: string[];
  node: boolean;
  nodeArgs?: string[];
}

const FORMATTED = /\.(c|m)?[jt]sx?$|\.(json|jsonc|css|ya?ml|toml)$/;
const SCRIPT = /\.(c|m)?[jt]sx?$/;

export function checksFor(files: readonly string[], binOf: (pkg: string, bin: string) => string): Check[] {
  const formatted = files.filter((f) => FORMATTED.test(f));
  const scripts = files.filter((f) => SCRIPT.test(f));
  const workflows = files.filter((f) => WORKFLOW_FILE.test(f));
  const bun = binOf("bun", "bin/bun.exe");
  const checks: Check[] = [];
  if (formatted.length)
    checks.push({ name: "format", bin: bun, args: ["fmt", "--no-script", "--check", "--no-error-on-unmatched-pattern", ...formatted], node: false });
  if (scripts.length) {
    checks.push({ name: "oxlint", bin: binOf("oxlint", "bin/oxlint"), args: ["--no-error-on-unmatched-pattern", ...scripts], node: true });
    checks.push({ name: "eslint", bin: binOf("eslint", "bin/eslint.js"), args: ["--no-warn-ignored", ...scripts], node: true });
    checks.push({ name: "types", bin: bun, args: ["check", "--no-script", "-p", "tsconfig.json"], node: false });
  }
  if (workflows.length)
    checks.push({
      name: "workflows",
      bin: "scripts/workflow-comments.ts",
      args: workflows,
      node: true,
      nodeArgs: ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"],
    });
  return checks;
}

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

function runWithOutputHeld(check: Check, root: string): Promise<Result> {
  const start = performance.now();
  return new Promise((resolve) => {
    const [bin, args] = check.node ? [process.execPath, [...(check.nodeArgs ?? []), check.bin, ...check.args]] : [check.bin, check.args];
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
  const results = await Promise.all(checksFor(files, binOf).map((c) => runWithOutputHeld(c, root)));
  for (const r of results.filter((r) => r.code !== 0)) console.error(`\n✗ ${r.name}\n${r.output.trimEnd()}`);
  const summary = results.map((r) => `${r.code === 0 ? "✓" : "✗"} ${r.name} ${(r.ms / 1000).toFixed(1)}s`).join(", ");
  console.error(`pre-push: ${files.length} changed files; ${summary || "nothing to check"} (${((performance.now() - start) / 1000).toFixed(1)}s)`);
  if (results.some((r) => r.code !== 0)) {
    console.error("Fix these before pushing; `bun run format` fixes formatting.");
    process.exitCode = 1;
  }
}
