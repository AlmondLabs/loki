import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { must } from "./fixtures/must.ts";

interface Step {
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}
interface Job {
  "runs-on": string;
  if?: string;
  needs?: string | string[];
  env?: Record<string, string>;
  strategy?: { "fail-fast"?: boolean; matrix?: { os?: string[]; shard?: number[] } };
  steps: Step[];
}
interface Workflow {
  on: Record<string, { paths?: string[]; "paths-ignore"?: string[] } | null>;
  concurrency?: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, Job>;
}
const workflow = (name: string) => parseYaml(readFileSync(join(import.meta.dirname, "..", ".github", "workflows", `${name}.yml`), "utf8")) as Workflow;
const install = parseYaml(readFileSync(join(import.meta.dirname, "..", ".github", "actions", "install", "action.yml"), "utf8")) as {
  runs: { steps: Step[] };
};
const runs = (job: Job) => job.steps.map((s) => s.run ?? "").join("\n");
// The jobs that install and check; mac-scope only decides whether the Mac one runs, and windows-result only reports
// the Windows shards as one check.
const checking = (wf: Workflow) => Object.entries(wf.jobs).filter(([name]) => name !== "mac-scope" && name !== "windows-result");
const SHARD = " --shard=${{ matrix.shard }}/2";

describe("ci: a PR's checks", () => {
  const ci = workflow("ci");

  test("runs on a PR, in the merge queue, weekly and by hand, and a newer push cancels the run before it", () => {
    expect(Object.keys(ci.on).sort()).toEqual(["merge_group", "pull_request", "schedule", "workflow_dispatch"]);
    expect(ci.concurrency).toEqual({ group: "ci-${{ github.event.pull_request.number || github.ref }}", "cancel-in-progress": true });
  });

  test("runs on every PR, docs alone included, so each required check reports; a docs-only PR passes each job before installing", () => {
    expect(ci.on.pull_request).toBeNull();
    // The Mac job is skipped as a whole on a PR that cannot reach it, docs alone included (the next block).
    for (const [name, job] of checking(ci).filter(([n]) => n !== "mac")) {
      const scope = job.steps.find((s) => s.id === "scope");
      expect(scope?.run, name).toContain("git diff --name-only HEAD^1 HEAD");
      // The skill the app ships is not a doc: skills/ is not in the list.
      expect(scope?.run, name).toContain("^(docs/|LICENSE$|\\.github/ISSUE_TEMPLATE/|[^/]+\\.md$)");
      const install = job.steps.find((s) => s.id === "install");
      expect(install?.if, name).toBe("steps.scope.outputs.docs_only != 'true'");
      const checks = job.steps.filter((s) => s.run && s.id !== "scope");
      for (const c of checks) expect(c.if, `${name}: ${c.run ?? ""}`).toMatch(/steps\.(install|bundle)\.outcome == 'success'/);
    }
  });

  test("types, format, lint, the suite and the bundles in jobs of their own on Linux, side by side; the suite on all three systems", () => {
    const linux: Record<string, string[]> = {
      typecheck: ["bun run typecheck"],
      format: ["bun run format:check"],
      lint: ["bun run lint"],
      test: ["bun run test", "bun run test:node"],
      build: ["bun run build:app", "bun run build:site", "bun run build:mod", "bun run smoke"],
    };
    for (const [name, commands] of Object.entries(linux)) {
      const job = must(ci.jobs[name], name);
      expect(job["runs-on"], name).toBe("ubuntu-22.04");
      expect(job.needs, name).toBeUndefined();
      for (const c of commands) expect(runs(job), name).toContain(c);
    }
    for (const [name, os] of [
      ["windows", "windows-latest"],
      ["mac", "macos-15"],
    ] as const) {
      const job = must(ci.jobs[name], name);
      expect(job["runs-on"], name).toBe(os);
      const tests = runs(job);
      expect(tests, name).toContain("bun run test");
      for (const once of ["typecheck", "lint", "build:app"]) expect(tests, name).not.toContain(once);
      expect(tests, name).toContain("bun run smoke");
    }
    // The required checks' names: the ruleset waits for these.
    const named = (job: string) => (must(ci.jobs[job], job) as Job & { name?: string }).name;
    expect(named("mac")).toBe("tests (macos-15)");
    expect(named("windows-result")).toBe("tests (windows-latest)");
    // Everything after the install is the same on both, but for Windows' shards: each runs half the suite, the first
    // the bundle and its smoke test, the second the Node runner's tests.
    const checks = (j: Job) =>
      j.steps
        .slice(j.steps.findIndex((s) => s.id === "install") + 1)
        .map((s) => ({ ...s, if: s.if?.replace(/ && matrix\.shard == [12]/, ""), run: s.run?.replace(SHARD, "") }));
    expect(checks(must(ci.jobs.windows, "windows"))).toEqual(checks(must(ci.jobs.mac, "mac")));
    expect(Object.keys(ci.jobs).sort()).toEqual(["build", "format", "lint", "mac", "mac-scope", "test", "typecheck", "windows", "windows-result"]);
  });

  test("Windows runs the suite in two shards, and its required check passes only when both did", () => {
    const windows = must(ci.jobs.windows, "windows");
    expect(windows.strategy).toEqual({ "fail-fast": false, matrix: { shard: [1, 2] } });
    const steps = windows.steps.filter((s) => s.run?.includes("bun run"));
    expect(steps.filter((s) => s.run?.endsWith(SHARD))).toHaveLength(1);
    expect(steps.filter((s) => s.if?.includes("matrix.shard == 1")).map((s) => s.run)).toEqual(["bun run --silent budget bun run build:mod"]);
    expect(steps.filter((s) => s.if?.includes("matrix.shard == 2")).map((s) => s.run)).toEqual(["bun run --silent budget bun run test:node"]);
    const result = must(ci.jobs["windows-result"], "windows-result");
    expect(result.needs).toBe("windows");
    expect(result.if).toBe("${{ !cancelled() }}");
    expect(runs(result)).toBe('test "${{ needs.windows.result }}" = success');
  });
});

describe("the Mac job: on a PR only when its diff can reach macOS", () => {
  const ci = workflow("ci");

  test("a Linux job decides on a PR only, from scripts/mac-scope.ts", () => {
    const scope = must(ci.jobs["mac-scope"], "mac-scope");
    expect(scope.if).toBe("github.event_name == 'pull_request'");
    expect(scope["runs-on"]).toBe("ubuntu-22.04");
    expect(runs(scope)).toContain("scripts/mac-scope.ts");
  });

  test("the Mac job runs unless the scope said no, so the queue, main, and a scope that failed all run it", () => {
    const mac = must(ci.jobs.mac, "mac");
    expect(mac.needs).toBe("mac-scope");
    expect(mac.if).toBe("${{ !cancelled() && needs.mac-scope.outputs.needed != 'false' }}");
  });
});

describe("install: node_modules from a cache main seeds", () => {
  const ci = workflow("ci");
  const cache = workflow("cache");
  const steps = install.runs.steps;

  test("every ci job installs through it, and none installs by itself", () => {
    for (const [name, job] of checking(ci)) {
      expect(
        job.steps.some((s) => s.uses === "./.github/actions/install"),
        name,
      ).toBe(true);
      expect(runs(job), name).not.toMatch(/\b(npm ci|npm install|bun install)\b/);
    }
  });

  test("keys on the lockfile, package.json's dependency fields, Node's major and the system, and runs bun install on a miss", () => {
    const key = steps.find((s) => s.id === "key")?.run ?? "";
    for (const part of ["bun.lock", "dependencies", "devDependencies", "overrides", "RUNNER_OS", "RUNNER_ARCH", "process.versions.node"])
      expect(key).toContain(part);
    const ci = steps.find((s) => s.run === "bun install --frozen-lockfile") as Step & { if?: string };
    expect(ci.if).toBe("steps.cache.outputs.cache-hit != 'true'");
  });

  test("is seeded on main for all three systems when the dependencies change, and daily so it never expires", () => {
    expect((cache.on.push as { branches?: string[] } | null)?.branches).toEqual(["main"]);
    expect(cache.on.push?.paths).toContain("bun.lock");
    expect(must(cache.jobs["node-modules"], "the seed job").strategy?.matrix?.os?.sort()).toEqual(["macos-15", "ubuntu-22.04", "windows-latest"]);
  });

  test("checks out a blobless clone with the whole history, so the merge base is there without every file's every version", () => {
    for (const [name, job] of Object.entries(ci.jobs).filter(([n]) => n !== "windows-result")) {
      const checkout = job.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
      expect(checkout?.with, name).toEqual({ "fetch-depth": 0, filter: "blob:none" });
    }
  });
});

describe("selection: a PR runs what its diff reaches, the merge queue runs everything", () => {
  const ci = workflow("ci");

  test("each suite step runs the selection on a pull_request and the whole suite otherwise (the queue, the weekly run, by hand)", () => {
    for (const name of ["test", "windows", "mac"]) {
      const step = must(ci.jobs[name], name).steps.find((s) => s.run?.includes("test:pr"));
      const shard = name === "windows" ? SHARD : "";
      expect(step?.run, name).toBe(`bun run --silent budget \${{ github.event_name == 'pull_request' && 'bun run test:pr' || 'bun run test' }}${shard}`);
    }
  });

  test("a PR lints the files its diff reaches, unless its plan says everything; anything else lints everything", () => {
    const steps = must(ci.jobs.lint, "lint").steps;
    const plan = steps.find((s) => s.id === "lint-plan");
    expect(plan?.if).toBe("${{ github.event_name == 'pull_request' && steps.install.outcome == 'success' }}");
    expect(plan?.run).toBe('bun run --silent lint:pr --plan >> "$GITHUB_OUTPUT"');
    expect(steps.at(-1)?.run).toBe(
      "bun run --silent budget ${{ github.event_name == 'pull_request' && steps.lint-plan.outputs.all != 'true' && 'bun run lint:pr' || 'bun run lint' }}",
    );
  });

  test("the Node runner's tests, the bundles and the smoke test are never narrowed", () => {
    for (const [name, job] of Object.entries(ci.jobs))
      for (const s of job.steps)
        for (const cmd of ["test:node", "build:mod", "smoke"])
          if (s.run?.includes(cmd)) expect(s.run, `${name}: ${cmd}`).toBe(`bun run --silent budget bun run ${cmd}`);
  });
});

describe("pr title: a required check", () => {
  const title = workflow("pr-title");

  test("reports in the merge queue too, skipped there: the title was checked on the PR", () => {
    expect(Object.keys(title.on).sort()).toEqual(["merge_group", "pull_request"]);
    expect((title.jobs.title as Job & { if?: string }).if).toBe("github.event_name == 'pull_request'");
  });
});

describe("main between PRs", () => {
  test("ci and the shell's tests run on main once a week, on a fixed weekday and hour", () => {
    for (const name of ["ci", "shell"]) {
      const schedule = (workflow(name).on as unknown as { schedule?: Array<{ cron: string }> }).schedule ?? [];
      expect(schedule, name).toHaveLength(1);
      // minute hour * * weekday: weekly, not daily or hourly.
      expect(schedule[0]?.cron, name).toMatch(/^\d{1,2} \d{1,2} \* \* [0-6]$/);
    }
  });
});

describe("shell: the Rust shell's tests", () => {
  const shell = workflow("shell");

  test("run for a PR that changes src-tauri, on the three systems", () => {
    expect(shell.on.pull_request?.paths).toContain("src-tauri/**");
    expect(shell.jobs.cargo.strategy?.matrix?.os?.sort()).toEqual(["macos-15", "ubuntu-22.04", "windows-latest"]);
  });

  test("need no Node and no app build: stand-ins for app/dist and the resources do", () => {
    const steps = shell.jobs.cargo.steps;
    expect(steps.some((s) => s.uses?.startsWith("actions/setup-node"))).toBe(false);
    expect(runs(shell.jobs.cargo)).not.toMatch(/\b(npm|bun) /);
    expect(runs(shell.jobs.cargo)).toContain("app/dist/index.html");
    expect(runs(shell.jobs.cargo)).toContain("cargo test --locked --manifest-path src-tauri/Cargo.toml");
    expect(runs(shell.jobs.cargo)).toContain("cargo fmt --manifest-path src-tauri/Cargo.toml --check");
    expect(runs(shell.jobs.cargo)).toContain("cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings");
  });
});

describe("React Doctor", () => {
  test("scans a PR that touches the React app, and not main again", () => {
    const rd = workflow("react-doctor");
    expect(Object.keys(rd.on)).toEqual(["pull_request"]);
    expect(rd.on.pull_request?.paths).toContain("app/**");
  });
});

describe("supply chain", () => {
  const all = ["ci", "cache", "shell", "react-doctor", "release"].map((name) => ({ name, wf: workflow(name) }));

  test("every action is pinned to a commit, not a tag that can move (the build holds the signing secrets), or is this repository's own", () => {
    const pinned = /^[\w.-]+\/[\w.-]+(\/[\w.-]+)?@[0-9a-f]{40}$/;
    for (const { name, wf } of all)
      for (const [job, j] of Object.entries(wf.jobs))
        for (const s of j.steps) if (s.uses && !s.uses.startsWith("./.github/actions/")) expect(s.uses, `${name}/${job}`).toMatch(pinned);
    for (const s of install.runs.steps) if (s.uses) expect(s.uses, "the install action").toMatch(pinned);
  });

  test("no runner image that moves under us (ubuntu-latest became Ubuntu 26 on 2026-10-19)", () => {
    for (const { name, wf } of all) for (const [job, j] of Object.entries(wf.jobs)) expect(j["runs-on"], `${name}/${job}`).not.toMatch(/^ubuntu-latest$/);
  });

  test("one macOS runner everywhere: the release builds on the Mac CI tests on (macos-14 was refused from 2026-11-06)", () => {
    const macs = new Set<string>();
    for (const { wf } of all)
      for (const j of Object.values(wf.jobs)) for (const os of [j["runs-on"], ...(j.strategy?.matrix?.os ?? [])]) if (os.startsWith("macos")) macs.add(os);
    expect([...macs]).toEqual(["macos-15"]);
  });

  test("release grants nothing by default; only the jobs that draft or publish can write", () => {
    const rel = workflow("release") as Workflow & { permissions?: unknown; jobs: Record<string, Job & { permissions?: Record<string, string> }> };
    expect(rel.permissions).toEqual({});
    const writers = Object.entries(rel.jobs)
      .filter(([, j]) => Object.values(j.permissions ?? {}).includes("write"))
      .map(([k]) => k)
      .sort();
    expect(writers).toEqual(["publish", "version"]);
    for (const [k, j] of Object.entries(rel.jobs)) expect(j.permissions, k).toBeDefined();
  });

  test("a release job that installs dependencies keeps no token in its checkout, and no Apple secret past the build", () => {
    const rel = workflow("release");
    const installers = Object.entries(rel.jobs).filter(([, j]) => /\bbun install\b/.test(runs(j)));
    expect(installers.map(([k]) => k).sort()).toEqual(["linux", "macos", "windows"]);
    for (const [k, j] of installers) {
      const checkout = j.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
      expect(checkout?.with?.["persist-credentials"], k).toBe(false);
    }
    const steps = must(rel.jobs.macos, "the macos job").steps;
    const built = steps.findIndex((s) => s.uses?.startsWith("tauri-apps/tauri-action@"));
    const dropped = steps.findIndex((s) => /APPLE_CERTIFICATE[^\n]*\n\s*echo "\$v=" >> "\$GITHUB_ENV"/.test(s.run ?? ""));
    expect(built).toBeGreaterThan(-1);
    expect(dropped).toBe(built + 1);
  });

  test("the update key reaches only the steps that build the app, as each step's own env", () => {
    const holders: string[] = [];
    for (const { name, wf } of all)
      for (const [job, j] of Object.entries(wf.jobs)) {
        expect(JSON.stringify(j.env ?? {}), `${name}/${job}`).not.toContain("TAURI_SIGNING");
        j.steps.forEach((s, i) => {
          if (JSON.stringify(s).includes("TAURI_SIGNING")) holders.push(`${name}/${job}/${s.uses?.split("@")[0] ?? String(i)}`);
        });
      }
    const release = workflow("release").jobs;
    const builds = [
      must(release.macos, "the macos job").steps.findIndex((s) => s.uses?.startsWith("tauri-apps/tauri-action@")),
      must(release.windows, "the windows job").steps.findIndex((s) => s.run?.includes("tauri build")),
      must(release.linux, "the linux job").steps.findIndex((s) => s.run?.includes("tauri build")),
    ];
    expect(holders).toEqual([`release/macos/tauri-apps/tauri-action`, `release/windows/${builds[1]}`, `release/linux/${builds[2]}`]);
    for (const [job, i] of [
      ["macos", builds[0]],
      ["windows", builds[1]],
      ["linux", builds[2]],
    ] as const)
      expect(must(release[job], job).steps[i]?.env, job).toEqual({
        TAURI_SIGNING_PRIVATE_KEY: "${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}",
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}",
      });
  });

  // tauri-cli only warns when the signing key and tauri.conf.json's pubkey are not one pair, and a loki built that way
  test("each build checks its update signatures against the compiled-in key before it ships them", () => {
    const release = workflow("release").jobs;
    for (const [job, isBuild, isShip] of [
      ["macos", (s: Step) => s.uses?.startsWith("tauri-apps/tauri-action@"), (s: Step) => s.uses?.startsWith("actions/upload-artifact@")],
      ["windows", (s: Step) => s.run?.includes("tauri build"), (s: Step) => s.uses?.startsWith("actions/upload-artifact@")],
      ["linux", (s: Step) => s.run?.includes("tauri build"), (s: Step) => s.uses?.startsWith("actions/upload-artifact@")],
    ] as const) {
      const steps = must(release[job], job).steps;
      const built = steps.findIndex(isBuild);
      const checked = steps.findIndex((s) => s.run?.includes("scripts/check-update-key.ts $(find src-tauri/target -path '*/bundle/*' -name '*.sig')"));
      const shipped = steps.findIndex(isShip);
      expect(built, job).toBeGreaterThan(-1);
      expect(checked, job).toBeGreaterThan(built);
      expect(shipped, job).toBeGreaterThan(checked);
      expect(JSON.stringify(steps[checked]), job).not.toContain("TAURI_SIGNING");
    }
  });
});
