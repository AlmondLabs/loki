import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The systems CI runs on, as GitHub names them in RUNNER_OS. */
export type Os = "Linux" | "macOS" | "Windows";

/**
 * Each CI step's budget in seconds, per system. A step that passes but runs past its budget fails the job, so CI
 * cannot slow down without someone deciding it should: raise a number here in the PR that needs it, and say why.
 *
 * Where a step meets the plan's target with room to spare the budget is the target (lint and types 5s, tests 60s,
 * setup 30s). Where it does not yet, the budget is about 1.5 times its slowest run in November 2026 and the target is
 * noted: oxlint's type-aware rules take 15s on GitHub's 4-core runners.
 */
export const BUDGETS: Readonly<Record<string, Partial<Record<Os, number>>>> = {
  "bun run format:check": { Linux: 5 },
  "bun run typecheck": { Linux: 5 },
  // The whole lint: the merge queue's, and a PR's that changes the lint's setup. Target 5s; 19–27s today.
  "bun run lint": { Linux: 40 },
  // A PR's lint, of the files its diff reaches.
  "bun run lint:pr": { Linux: 5 },
  // Windows runs the suite in two shards (ci.yml), each held to this.
  "bun run test": { Linux: 60, macOS: 60, Windows: 60 },
  "bun run test:pr": { Linux: 60, macOS: 60, Windows: 60 },
  "bun run test:node": { Linux: 30, macOS: 30, Windows: 30 },
  "bun run build:app": { Linux: 60 },
  "bun run build:site": { Linux: 20 },
  "bun run build:mod": { Linux: 10, macOS: 10, Windows: 10 },
  "bun run smoke": { Linux: 30, macOS: 30, Windows: 30 },
  // From the install action's start to node_modules in place, on a cache hit. A miss runs bun install, which a PR that
  // changes the dependencies needs, so it has no budget.
  install: { Linux: 30, macOS: 30, Windows: 30 },
};

// A shard of the suite is held to the suite's budget: the target is per shard.
const SHARD = / --shard=\d+\/\d+$/;

/** A step's budget on a system; a step without one is an error, so every step CI runs is given one. */
export function budgetFor(step: string, os: Os): number {
  const budget = BUDGETS[step.replace(SHARD, "")]?.[os];
  if (budget === undefined) throw new Error(`${step} has no budget on ${os}: add one to scripts/budget.ts`);
  return budget;
}

/**
 * What a step's run means for its job: its own failure first, else a failure when it ran past its budget. The
 * message is a GitHub annotation, so it shows on the PR's checks.
 */
export function verdict(step: string, code: number, seconds: number, budget: number): { code: number; message: string } {
  const took = `${step} took ${seconds.toFixed(1)}s; its budget is ${budget}s.`;
  if (code !== 0) return { code, message: took };
  if (seconds > budget)
    return { code: 1, message: `::error title=Over its budget::${took} Make it faster, or raise its budget in scripts/budget.ts and say why in the PR.` };
  return { code: 0, message: took };
}

function osOf(): Os {
  const named = process.env.RUNNER_OS;
  if (named === "Linux" || named === "macOS" || named === "Windows") return named;
  return process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux";
}

// budget.ts <command…> runs the command and judges it; budget.ts --took <seconds> <step> judges a step timed
// elsewhere (the install action, which is several steps).
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const os = osOf();
  if (args[0] === "--took") {
    const step = args[2] ?? "";
    const v = verdict(step, 0, Number(args[1]), budgetFor(step, os));
    console.log(v.message);
    process.exitCode = v.code;
  } else {
    const step = args.join(" ");
    const budget = budgetFor(step, os);
    const start = performance.now();
    const child = spawn(step, { shell: true, stdio: "inherit" });
    // A step that hangs stops at three times its budget rather than at the job's six-hour limit.
    const guard = setTimeout(() => child.kill(), budget * 3 * 1000);
    child.on("exit", (code) => {
      clearTimeout(guard);
      const v = verdict(step, code ?? 1, (performance.now() - start) / 1000, budget);
      console.log(v.message);
      process.exitCode = v.code;
    });
  }
}
