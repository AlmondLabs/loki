import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type Os = "Linux" | "macOS" | "Windows";

export const BUDGETS: Readonly<Record<string, Partial<Record<Os, number>>>> = {
  "bun run format:check": { Linux: 5 },
  "bun run typecheck": { Linux: 5 },
  // Outside (oxlint): its type-aware rules take 15s on GitHub's 4-core runners.
  "bun run lint": { Linux: 40 },
  "bun run lint:pr": { Linux: 25 },
  "bun run test": { Linux: 60, macOS: 60, Windows: 60 },
  "bun run test:pr": { Linux: 60, macOS: 60, Windows: 60 },
  "bun run test:node": { Linux: 30, macOS: 30, Windows: 30 },
  "bun run build:app": { Linux: 60 },
  "bun run build:site": { Linux: 20 },
  "bun run build:mod": { Linux: 10, macOS: 10, Windows: 10 },
  "bun run smoke": { Linux: 30, macOS: 30, Windows: 30 },
  "bun run dist --dir": { Linux: 120, macOS: 120, Windows: 180 },
  "bun run smoke --electron": { Linux: 60, macOS: 60, Windows: 90 },
  "xvfb-run -a bun run smoke --electron": { Linux: 60 },
  install: { Linux: 30, macOS: 30, Windows: 30 },
};

const SHARD_FLAG = / --shard=\d+\/\d+$/;
const HUNG_STEP_BUDGETS = 3;

export function budgetFor(step: string, os: Os): number {
  const stepOfWholeSuite = step.replace(SHARD_FLAG, "");
  const budget = BUDGETS[stepOfWholeSuite]?.[os];
  if (budget === undefined) throw new Error(`${step} has no budget on ${os}: add one to scripts/budget.ts`);
  return budget;
}

const githubErrorAnnotation = (title: string, text: string) => `::error title=${title}::${text}`;

export function verdict(step: string, code: number, seconds: number, budget: number): { code: number; message: string } {
  const took = `${step} took ${seconds.toFixed(1)}s; its budget is ${budget}s.`;
  if (code !== 0) return { code, message: took };
  if (seconds > budget)
    return {
      code: 1,
      message: githubErrorAnnotation("Over its budget", `${took} Make it faster, or raise its budget in scripts/budget.ts and say why in the PR.`),
    };
  return { code: 0, message: took };
}

function osOf(): Os {
  const named = process.env.RUNNER_OS;
  if (named === "Linux" || named === "macOS" || named === "Windows") return named;
  return process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux";
}

function judgeStepTimedElsewhere(seconds: number, step: string, os: Os) {
  const v = verdict(step, 0, seconds, budgetFor(step, os));
  console.log(v.message);
  process.exitCode = v.code;
}

function runAndJudge(step: string, os: Os) {
  const budget = budgetFor(step, os);
  const start = performance.now();
  const child = spawn(step, { shell: true, stdio: "inherit" });
  const killWhenHung = setTimeout(() => child.kill(), budget * HUNG_STEP_BUDGETS * 1000);
  child.on("exit", (code) => {
    clearTimeout(killWhenHung);
    const v = verdict(step, code ?? 1, (performance.now() - start) / 1000, budget);
    console.log(v.message);
    process.exitCode = v.code;
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === "--took") judgeStepTimedElsewhere(Number(args[1]), args[2] ?? "", osOf());
  else runAndJudge(args.join(" "), osOf());
}
