import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { must } from "./fixtures/must.ts";

interface Step {
  id?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}
interface Job {
  "runs-on": string;
  needs?: string | string[];
  env?: Record<string, string>;
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

  test("starts nothing for a PR of docs alone, but runs for the skill the app ships", () => {
    const ignored = ci.on.pull_request?.["paths-ignore"] ?? [];
    for (const p of ["docs/**", "*.md"]) expect(ignored).toContain(p);
    for (const p of [".github/release.txt", ".github/preview.txt"]) expect(ignored).not.toContain(p);
    expect(ignored.some((p) => p.startsWith("skills"))).toBe(false);
  });

  test("types, format, lint, the suite and the bundles in jobs of their own on Linux, side by side; the suite on all three systems", () => {
    const linux: Record<string, string[]> = {
      typecheck: ["npm run typecheck"],
      format: ["npm run format:check"],
      lint: ["npm run lint"],
      test: ["npm test", "npm run test:node"],
      build: ["npm run build:app", "npm run build:site", "npm run build:mod", "npm run smoke"],
    };
    for (const [name, commands] of Object.entries(linux)) {
      const job = must(ci.jobs[name], name);
      expect(job["runs-on"], name).toBe("ubuntu-22.04");
      expect(job.needs, name).toBeUndefined();
      for (const c of commands) expect(runs(job), name).toContain(c);
    }
    expect(ci.jobs.tests.strategy?.matrix?.os?.sort()).toEqual(["macos-15", "windows-latest"]);
    const tests = runs(ci.jobs.tests);
    expect(tests).toContain("npm test");
    for (const once of ["typecheck", "lint", "build:app"]) expect(tests).not.toContain(once);
    expect(tests).toContain("npm run smoke");
    expect(Object.keys(ci.jobs).sort()).toEqual(["build", "format", "lint", "test", "tests", "typecheck"]);
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
    const installers = Object.entries(rel.jobs).filter(([, j]) => /\bnpm ci\b/.test(runs(j)));
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
      must(release.windows, "the windows job").steps.findIndex((s) => s.run?.includes("tauri -- build")),
      must(release.linux, "the linux job").steps.findIndex((s) => s.run?.includes("tauri -- build")),
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
      ["windows", (s: Step) => s.run?.includes("tauri -- build"), (s: Step) => s.uses?.startsWith("actions/upload-artifact@")],
      ["linux", (s: Step) => s.run?.includes("tauri -- build"), (s: Step) => s.uses?.startsWith("actions/upload-artifact@")],
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
