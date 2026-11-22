import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface Linter {
  name: string;
  bin: string;
  args: string[];
}

export function linters(eslintArgs: readonly string[], files?: readonly string[]): Linter[] {
  const require = createRequire(import.meta.url);
  const binOf = (pkg: string, bin: string) => join(dirname(require.resolve(`${pkg}/package.json`)), bin);
  if (files)
    return [
      { name: "oxlint", bin: binOf("oxlint", "bin/oxlint"), args: ["--no-error-on-unmatched-pattern", ...files] },
      { name: "eslint", bin: binOf("eslint", "bin/eslint.js"), args: ["--no-warn-ignored", ...eslintArgs, ...files] },
    ];
  return [
    { name: "oxlint", bin: binOf("oxlint", "bin/oxlint"), args: [] },
    { name: "eslint", bin: binOf("eslint", "bin/eslint.js"), args: [".", "--concurrency", "auto", ...eslintArgs] },
  ];
}

export async function lintAll(list: readonly Linter[], run: (l: Linter) => Promise<number>): Promise<number> {
  const codes = await Promise.all(list.map(run));
  return codes.find((c) => c !== 0) ?? 0;
}

function runNode(l: Linter): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [l.bin, ...l.args], { stdio: "inherit" });
    child.on("error", () => resolve(1));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await lintAll(linters(process.argv.slice(2)), runNode);
}
