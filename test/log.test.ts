import { expect, test, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reporter } from "../daemon/report.ts";
import { LOG_CHECK_EVERY, initLog, log, rotateIfLarge } from "../mod/log.ts";

test("a log past the cap is renamed to .1 and a fresh one starts", () => {
  const dir = mkdtempSync(join(tmpdir(), "loki-log-"));
  const path = join(dir, "mod.log");
  writeFileSync(path, "x".repeat(2048));
  expect(rotateIfLarge(path, 1024)).toBe(true);
  expect(existsSync(`${path}.1`)).toBe(true);
  expect(existsSync(path)).toBe(false);
  expect(rotateIfLarge(path, 1024)).toBe(false);
});

test("a line has its time, its severity, the event and its detail", () => {
  vi.useFakeTimers({ now: new Date("2026-11-24T11:17:01.759Z") });
  const dir = mkdtempSync(join(tmpdir(), "loki-log-"));
  const path = join(dir, "mod.log");
  initLog(path);
  log("server:listening", { port: 41414 });
  log.warning("slack:rate-limited", "wait 30s");
  log.error("server:failed");
  expect(readFileSync(path, "utf8").split("\n").filter(Boolean)).toEqual([
    '2026-11-24T11:17:01.759Z info server:listening {"port":41414}',
    "2026-11-24T11:17:01.759Z warning slack:rate-limited wait 30s",
    "2026-11-24T11:17:01.759Z error server:failed",
  ]);
});

test("the daemon's report is an error unless it says otherwise, and names the process", () => {
  const lines: string[] = [];
  const report = reporter({ pid: 4242, write: (line) => lines.push(line), now: () => new Date("2026-11-24T11:17:01.759Z") });
  report("store of friday did not open: locked");
  report("SIGTERM, stopping", "info");
  expect(lines).toEqual([
    "2026-11-24T11:17:01.759Z error loki-daemon[4242]: store of friday did not open: locked",
    "2026-11-24T11:17:01.759Z info loki-daemon[4242]: SIGTERM, stopping",
  ]);
});

test("log() checks the size every LOG_CHECK_EVERY lines and keeps writing", () => {
  const dir = mkdtempSync(join(tmpdir(), "loki-log-"));
  const path = join(dir, "mod.log");
  initLog(path);
  for (let i = 0; i < LOG_CHECK_EVERY + 5; i++) log("event", { i });
  expect(statSync(path).size).toBeGreaterThan(0);
  expect(readFileSync(path, "utf8").split("\n").filter(Boolean).length).toBe(LOG_CHECK_EVERY + 5);
});
