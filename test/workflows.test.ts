import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { must } from "./fixtures/must.ts";

/** The CI workflows' shape (docs/CONTRIBUTING.md, Checks): each check once, where the system matters, and only when it can say something. */

interface Step {
  id?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}
interface Job {
  "runs-on": string;
  strategy?: { matrix?: { os?: string[] } };
  steps: Step[];
}
interface Workflow {
  on: Record<string, { paths?: string[]; "paths-ignore"?: string[] } | null>;
  concurrency?: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, Job>;
}
const workflow = (name: string) => parseYaml(readFileSync(join(import.meta.dirname, "..", ".github", "workflows", `${name}.yml`), "utf8")) as Workflow;
const runs = (job: Job) => job.steps.map((s) => s.run ?? "").join("\n");

describe("ci: a PR's checks", () => {
  const ci = workflow("ci");

  test("runs on a PR (and by hand), not again on its merge, and a newer push cancels the run before it", () => {
    expect(Object.keys(ci.on).sort()).toEqual(["pull_request", "schedule", "workflow_dispatch"]);
    expect(ci.concurrency).toEqual({ group: "ci-${{ github.event.pull_request.number || github.ref }}", "cancel-in-progress": true });
  });

  test("starts nothing for a PR of docs or the release PRs' markers, but runs for the skill the app ships", () => {
    const ignored = ci.on.pull_request?.["paths-ignore"] ?? [];
    for (const p of ["docs/**", "*.md", ".github/release.txt", ".github/preview.txt"]) expect(ignored).toContain(p);
    expect(ignored.some((p) => p.startsWith("skills"))).toBe(false);
  });

  test("types, lint, the Node runner's tests and both bundles once, on Linux; the suite on all three systems", () => {
    const checks = runs(ci.jobs.checks);
    for (const c of ["npm run typecheck", "npm run lint", "npm test", "npm run test:node", "npm run build:app", "npm run build:mod", "npm run smoke"])
      expect(checks).toContain(c);
    expect(ci.jobs.tests.strategy?.matrix?.os?.sort()).toEqual(["macos-15", "windows-latest"]);
    const tests = runs(ci.jobs.tests);
    expect(tests).toContain("npm test");
    for (const once of ["typecheck", "lint", "build:app"]) expect(tests).not.toContain(once);
    expect(tests).toContain("npm run smoke"); // the bundle on each system: the keychain module, paths, processes
    expect(Object.keys(ci.jobs).sort()).toEqual(["checks", "tests"]); // the Rust shell is shell.yml's
  });
});

describe("main between PRs", () => {
  // Nothing ran on main after a merge, so a refused runner went unseen for four days (macos-14, 2026-11-06).
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
    expect(runs(shell.jobs.cargo)).not.toMatch(/npm /);
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
  const all = ["ci", "shell", "react-doctor", "release"].map((name) => ({ name, wf: workflow(name) }));

  test("every action is pinned to a commit, not a tag that can move (the build holds the signing secrets)", () => {
    for (const { name, wf } of all)
      for (const [job, j] of Object.entries(wf.jobs))
        for (const s of j.steps) if (s.uses) expect(s.uses, `${name}/${job}`).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
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

  test("release grants nothing by default; only the jobs that publish or open PRs can write", () => {
    const rel = workflow("release") as Workflow & { permissions?: unknown; jobs: Record<string, Job & { permissions?: Record<string, string> }> };
    expect(rel.permissions).toEqual({});
    const writers = Object.entries(rel.jobs)
      .filter(([, j]) => Object.values(j.permissions ?? {}).includes("write"))
      .map(([k]) => k)
      .sort();
    expect(writers).toEqual(["attach", "build", "preview-pr-after-stable", "release-prs"]);
    for (const [k, j] of Object.entries(rel.jobs)) expect(j.permissions, k).toBeDefined();
  });

  test("a release job that installs dependencies keeps no token in its checkout, and no Apple secret past the build", () => {
    const rel = workflow("release");
    const installers = Object.entries(rel.jobs).filter(([, j]) => /\bnpm ci\b/.test(runs(j)));
    expect(installers.map(([k]) => k).sort()).toEqual(["build", "linux", "windows"]);
    for (const [k, j] of installers) {
      const checkout = j.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
      expect(checkout?.with?.["persist-credentials"], k).toBe(false);
    }
    const steps = must(rel.jobs.build, "the build job").steps;
    const built = steps.findIndex((s) => s.uses?.startsWith("tauri-apps/tauri-action@"));
    const dropped = steps.findIndex((s) => /APPLE_CERTIFICATE[^\n]*\n\s*echo "\$v=" >> "\$GITHUB_ENV"/.test(s.run ?? ""));
    expect(built).toBeGreaterThan(-1);
    expect(dropped).toBe(built + 1);
  });
});
