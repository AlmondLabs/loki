import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOG_CHECK_EVERY, initLog, log, rotateIfLarge } from "../mod/log.ts";

test("a log past the cap is renamed to .1 and a fresh one starts", () => {
  const dir = mkdtempSync(join(tmpdir(), "loki-log-"));
  const path = join(dir, "mod.log");
  writeFileSync(path, "x".repeat(2048));
  expect(rotateIfLarge(path, 1024)).toBe(true);
  expect(existsSync(`${path}.1`)).toBe(true);
  expect(existsSync(path)).toBe(false);
  expect(rotateIfLarge(path, 1024)).toBe(false); // nothing there yet: not an error
});

test("log() checks the size every LOG_CHECK_EVERY lines and keeps writing", () => {
  const dir = mkdtempSync(join(tmpdir(), "loki-log-"));
  const path = join(dir, "mod.log");
  initLog(path);
  for (let i = 0; i < LOG_CHECK_EVERY + 5; i++) log("event", { i });
  expect(statSync(path).size).toBeGreaterThan(0);
  expect(readFileSync(path, "utf8").split("\n").filter(Boolean).length).toBe(LOG_CHECK_EVERY + 5);
});
