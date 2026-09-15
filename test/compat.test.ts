import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MIN_LETTA_CODE, TESTED_APP_SERVER_REPORT, TESTED_LETTA_CODE, compareVersions, lettaStanding } from "../core/compat.ts";

describe("letta code compatibility range", () => {
  test("compares dotted versions the way npm does", () => {
    expect(compareVersions("0.32.10", "0.32.9")).toBe(1);
    expect(compareVersions("0.32", "0.32.0")).toBe(0);
    expect(compareVersions("v0.31.12 (Letta Code)", "0.31.12")).toBe(0);
    expect(compareVersions("0.31.14", "0.32.0")).toBe(-1);
  });

  test("places a reported version against the range", () => {
    expect(lettaStanding(TESTED_LETTA_CODE)).toBe("tested");
    expect(lettaStanding(TESTED_APP_SERVER_REPORT)).toBe("tested"); // what the tested build's app-server says of itself
    expect(lettaStanding(MIN_LETTA_CODE)).toBe(compareVersions(MIN_LETTA_CODE, TESTED_LETTA_CODE) === 0 ? "tested" : "older");
    expect(lettaStanding("0.30.0")).toBe("too_old");
    expect(lettaStanding("9.0.0")).toBe("newer");
    expect(lettaStanding(null)).toBeNull();
    expect(lettaStanding("")).toBeNull();
  });

  test("the range is well-formed and the minimum does not exceed the tested release", () => {
    expect(MIN_LETTA_CODE).toMatch(/^\d+\.\d+\.\d+$/);
    expect(TESTED_LETTA_CODE).toMatch(/^\d+\.\d+\.\d+$/);
    expect(compareVersions(MIN_LETTA_CODE, TESTED_LETTA_CODE)).toBeLessThanOrEqual(0);
  });

  test("the shell no longer pins a release: it installs npm's latest", () => {
    const rs = readFileSync(new URL("../src-tauri/src/bootstrap.rs", import.meta.url), "utf8");
    expect(rs).not.toMatch(/LETTA_CODE_VERSION/);
    expect(rs).toContain('install_version(home, "latest", report)');
  });
});
