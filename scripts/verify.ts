import { execFileSync, spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface VerifyTask {
  id: string;
  command: string[];
  after?: readonly string[];
}

export interface TaskResult {
  id: string;
  code: number;
  ms: number;
  output: string;
  skipped?: boolean;
}

export const APP_BUILD_INPUT = /^(app\/|core\/|package\.json$|bun\.lock$|tsconfig)/;

export function needsAppBuild(changes: readonly string[], distExists: boolean): boolean {
  return !distExists || changes.some((p) => APP_BUILD_INPUT.test(p));
}

export function verifyGraph(opts: { pr: boolean; base?: string; buildApp: boolean }): VerifyTask[] {
  const baseArg = opts.base ? [opts.base] : [];
  const afterStatic = opts.pr || !opts.buildApp ? ["lint", "typecheck"] : ["lint", "typecheck", "build:app"];
  const tasks: VerifyTask[] = [
    { id: "format", command: ["bun", "run", "format:check"] },
    { id: "typecheck", command: ["bun", "run", "typecheck"] },
    { id: "lint", command: opts.pr ? ["bun", "run", "lint:pr", ...baseArg] : ["bun", "run", "lint"] },
    // Run full Vitest and Node test suites after heavy multi-threaded static/Vite work so CPU/FSEvents timers stay reliable.
    { id: "test", command: opts.pr ? ["bun", "run", "test:pr", ...baseArg] : ["bun", "run", "test"], after: afterStatic },
    { id: "test:node", command: ["bun", "run", "test:node"], after: ["test"] },
  ];
  if (opts.buildApp) {
    tasks.push(
      { id: "build:app", command: ["bun", "run", "build:app"], after: ["typecheck"] },
      { id: "build:mod", command: ["bun", "run", "build:mod"], after: ["build:app"] },
      { id: "smoke", command: ["bun", "run", "smoke"], after: ["build:mod"] },
    );
  } else {
    tasks.push({ id: "build:mod", command: ["bun", "run", "build:mod"] }, { id: "smoke", command: ["bun", "run", "smoke"], after: ["build:mod"] });
  }
  return tasks;
}

export async function runGraph(
  tasks: readonly VerifyTask[],
  runner: (task: VerifyTask) => Promise<{ code: number; output: string; ms: number }>,
): Promise<{ ok: boolean; results: TaskResult[] }> {
  const pending = new Set(tasks.map((t) => t.id));
  const settled = new Map<string, TaskResult>();
  const running = new Map<string, Promise<void>>();

  const finish = (res: TaskResult): void => {
    settled.set(res.id, res);
    pending.delete(res.id);
  };

  while (pending.size > 0 || running.size > 0) {
    let progressed = false;
    for (const task of tasks) {
      if (!pending.has(task.id) || running.has(task.id)) continue;
      const deps = task.after ?? [];
      const failedDep = deps.find((d) => {
        const s = settled.get(d);
        return s !== undefined && (s.code !== 0 || s.skipped);
      });
      if (failedDep) {
        finish({ id: task.id, code: 1, ms: 0, output: "", skipped: true });
        progressed = true;
        continue;
      }
      if (!deps.every((d) => settled.has(d))) continue;
      progressed = true;
      const job = runner(task).then(
        (r) => {
          running.delete(task.id);
          finish({ id: task.id, ...r });
        },
        (error: unknown) => {
          running.delete(task.id);
          finish({ id: task.id, code: 1, ms: 0, output: String(error) });
        },
      );
      running.set(task.id, job);
    }
    if (running.size > 0) await Promise.race(running.values());
    else if (!progressed && pending.size > 0) {
      for (const id of pending) finish({ id, code: 1, ms: 0, output: "unresolvable task dependency", skipped: true });
    }
  }

  const results = tasks.map((t) => settled.get(t.id)).filter((r): r is TaskResult => r !== undefined);
  return { ok: results.every((r) => r.code === 0 && !r.skipped), results };
}

function defaultBase(root: string): string {
  try {
    return execFileSync("git", ["merge-base", "main", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "HEAD^1";
  }
}

function changedFiles(root: string, base: string): string[] {
  try {
    const committed = execFileSync("git", ["diff", "--name-only", base, "HEAD"], { cwd: root, encoding: "utf8" }).split("\n");
    const working = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .map((l) => l.slice(3).trim())
      .filter(Boolean);
    return [...new Set([...committed, ...working].filter(Boolean))];
  } catch {
    return [];
  }
}

function runCommand(task: VerifyTask, cwd: string): Promise<{ code: number; output: string; ms: number }> {
  const started = performance.now();
  return new Promise((resolvePromise) => {
    const child = spawn(task.command[0], task.command.slice(1), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      output += d;
    });
    child.stderr.on("data", (d: string) => {
      output += d;
    });
    child.once("error", (err) => {
      resolvePromise({ code: 1, output: `${output}\n${err.message}`, ms: performance.now() - started });
    });
    child.once("close", (code) => {
      resolvePromise({ code: code ?? 1, output, ms: performance.now() - started });
    });
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const args = process.argv.slice(2);
  const pr = args.includes("--pr");
  const baseIdx = args.indexOf("--base");
  const base = baseIdx >= 0 ? args[baseIdx + 1] : pr ? defaultBase(root) : undefined;
  const distExists = existsSync(join(root, "app", "dist", "index.html"));
  const buildApp = pr ? needsAppBuild(changedFiles(root, base ?? "HEAD^1"), distExists) : true;
  const tasks = verifyGraph({ pr, base, buildApp });
  const started = performance.now();
  console.log(`verify (${pr ? "pr" : "full"}): running ${tasks.map((t) => t.id).join(", ")}`);
  const { ok, results } = await runGraph(tasks, async (task) => {
    const r = await runCommand(task, root);
    const label = r.code === 0 ? "✓" : "✖";
    console.log(`  ${label} ${task.id} (${(r.ms / 1000).toFixed(1)}s)`);
    return r;
  });
  for (const r of results) {
    if (r.skipped) console.log(`  - ${r.id} (skipped)`);
    else if (r.code !== 0) {
      console.error(`\n--- ${r.id} failed ---\n${r.output.trim()}`);
    }
  }
  console.log(`verify finished in ${((performance.now() - started) / 1000).toFixed(1)}s`);
  process.exitCode = ok ? 0 : 1;
}
