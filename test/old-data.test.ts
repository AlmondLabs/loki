import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkOldData } from "../daemon/old-data.ts";

const dirs: string[] = [];

function folder() {
  const dir = mkdtempSync(join(tmpdir(), "loki-old-data-"));
  dirs.push(dir);
  const stateDir = join(dir, "state");
  const storesDir = join(dir, "stores");
  const write = (file: string, value: unknown) => {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  };
  const check = (agents: string[] = []) => checkOldData({ stateDir, storesDir, agents });
  const marker = () => JSON.parse(readFileSync(join(stateDir, "migrations.json"), "utf8")) as unknown;
  return { stateDir, storesDir, write, check, marker };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a loki folder that no build from 2026.1116 has started", () => {
  test("an agent without the marker is refused, and the refusal names the release to run", () => {
    const f = folder();
    const verdict = f.check(["a1"]);
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toContain("2026.1116");
  });

  test("a saved state file without the marker is refused", () => {
    const f = folder();
    f.write(join(f.stateDir, "devices.json"), []);
    expect(f.check().ok).toBe(false);
  });

  test("a store without the marker is refused", () => {
    const f = folder();
    f.write(join(f.storesDir, "a1.sqlite"), "");
    expect(f.check().ok).toBe(false);
  });

  test("a malformed marker file next to loki data is refused, not crashed on", () => {
    const f = folder();
    f.write(join(f.stateDir, "migrations.json"), "{not json");
    expect(f.check(["a1"]).ok).toBe(false);
  });
});

describe("a loki folder 2026.1116 has started", () => {
  test("the marker beside the task move's record passes", () => {
    const f = folder();
    f.write(join(f.stateDir, "migrations.json"), { agents: 1, tasks_moved: ["t1"] });
    expect(f.check(["a1"])).toEqual({ ok: true });
  });

  test("a listed agent's store left below the last store conversion is refused, by name", () => {
    const f = folder();
    f.write(join(f.stateDir, "migrations.json"), { agents: 1 });
    f.write(join(f.storesDir, "a1.sqlite"), "");
    f.write(join(f.storesDir, "migrations.json"), { "a1.sqlite": 2 });
    const verdict = f.check(["a1"]);
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toContain("a1.sqlite");
  });

  test("a store with no mark passes", () => {
    const f = folder();
    f.write(join(f.stateDir, "migrations.json"), { agents: 1 });
    f.write(join(f.storesDir, "a1.sqlite"), "");
    expect(f.check(["a1"])).toEqual({ ok: true });
  });

  test("a leftover mark for a store whose file is gone, or whose agent is not listed, passes", () => {
    const f = folder();
    f.write(join(f.stateDir, "migrations.json"), { agents: 1 });
    f.write(join(f.storesDir, "a1.sqlite"), "");
    f.write(join(f.storesDir, "helper.sqlite"), "");
    f.write(join(f.storesDir, "migrations.json"), { "a1.sqlite": 3, "gone.sqlite": 2, "helper.sqlite": 2 });
    expect(f.check(["a1", "gone"])).toEqual({ ok: true });
  });
});

describe("a fresh loki folder", () => {
  test("passes and gets the marker, so the next start passes with data in it", () => {
    const f = folder();
    expect(f.check()).toEqual({ ok: true });
    expect(f.marker()).toEqual({ agents: 1 });
    f.write(join(f.storesDir, "a1.sqlite"), "");
    expect(f.check(["a1"])).toEqual({ ok: true });
  });

  test("keeps the task move's record when the marker is added", () => {
    const f = folder();
    f.write(join(f.stateDir, "migrations.json"), { tasks_moved: ["t1"] });
    expect(f.check()).toEqual({ ok: true });
    expect(f.marker()).toEqual({ tasks_moved: ["t1"], agents: 1 });
  });
});
