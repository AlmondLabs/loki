import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { TESTED_APP_SERVER_REPORT, TESTED_LETTA_CODE, lettaCompatible } from "../packages/core/src/compat.ts";

test("compatibility compares major.minor of what the harness reports", () => {
  expect(lettaCompatible(null)).toBeNull();
  expect(lettaCompatible(TESTED_APP_SERVER_REPORT)).toBe(true);
  expect(lettaCompatible("0.30.99")).toBe(true);
  expect(lettaCompatible("0.31.0")).toBe(false);
  expect(lettaCompatible("v1.0.0")).toBe(false);
  expect(TESTED_LETTA_CODE).toMatch(/^\d+\.\d+\.\d+$/);
});

test("the shell pins the same Letta Code release it installs", () => {
  const rs = readFileSync(new URL("../src-tauri/src/bootstrap.rs", import.meta.url), "utf8");
  const pinned = rs.match(/pub const LETTA_CODE_VERSION: &str = "([^"]+)"/)?.[1];
  expect(pinned).toBe(TESTED_LETTA_CODE);
});
