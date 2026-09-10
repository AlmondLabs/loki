import { expect, test } from "bun:test";
import { isNewerVersion, parseVersion } from "../packages/core/src/version.ts";

test("release tags and plain versions parse alike", () => {
  expect(parseVersion("v0.3.0")).toEqual([0, 3, 0]);
  expect(parseVersion("0.3.0")).toEqual([0, 3, 0]);
  expect(parseVersion("nightly")).toBeNull();
});

test("newer means strictly after, per component", () => {
  expect(isNewerVersion("0.3.0", "v0.3.1")).toBe(true);
  expect(isNewerVersion("0.3.0", "0.4.0")).toBe(true);
  expect(isNewerVersion("0.3.0", "1.0.0")).toBe(true);
  expect(isNewerVersion("0.3.0", "0.3.0")).toBe(false);
  expect(isNewerVersion("0.3.1", "0.3.0")).toBe(false);
  expect(isNewerVersion("0.3.0", "garbage")).toBe(false);
});
