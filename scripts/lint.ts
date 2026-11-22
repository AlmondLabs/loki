import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface Linter {
  name: string;
  bin: string;
  args: string[];
  nodeArgs?: string[];
}

export const WORKFLOW_FILE = /^\.github\/.*\.yml$/;

export function linters(eslintArgs: readonly string[], files?: readonly string[]): Linter[] {
  const require = createRequire(import.meta.url);
  const binOf = (pkg: string, bin: string) => join(dirname(require.resolve(`${pkg}/package.json`)), bin);
  const workflows = (args: string[]): Linter => ({
    name: "workflows",
    bin: join(dirname(fileURLToPath(import.meta.url)), "workflow-comments.ts"),
    args,
    nodeArgs: ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"],
  });
  if (files) {
    const code = files.filter((f) => !WORKFLOW_FILE.test(f));
    const yaml = files.filter((f) => WORKFLOW_FILE.test(f));
    return [
      ...(code.length > 0
        ? [
            { name: "oxlint", bin: binOf("oxlint", "bin/oxlint"), args: ["--no-error-on-unmatched-pattern", ...code] },
            { name: "eslint", bin: binOf("eslint", "bin/eslint.js"), args: ["--no-warn-ignored", ...eslintArgs, ...code] },
          ]
        : []),
      ...(yaml.length > 0 ? [workflows(yaml)] : []),
    ];
  }
  return [
    { name: "oxlint", bin: binOf("oxlint", "bin/oxlint"), args: [] },
    { name: "eslint", bin: binOf("eslint", "bin/eslint.js"), args: [".", "--concurrency", "auto", ...eslintArgs] },
    workflows([]),
  ];
}

export async function lintAll(list: readonly Linter[], run: (l: Linter) => Promise<number>): Promise<number> {
  const codes = await Promise.all(list.map(run));
  return codes.find((c) => c !== 0) ?? 0;
}

function runNode(l: Linter): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...(l.nodeArgs ?? []), l.bin, ...l.args], { stdio: "inherit" });
    child.on("error", () => resolve(1));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await lintAll(linters(process.argv.slice(2)), runNode);
}
