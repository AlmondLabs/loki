import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquire } from "../daemon/lock.ts";

function dir() {
  return mkdtempSync(join(tmpdir(), "loki-lock-"));
}

describe("daemon lock", () => {
  test("the first taker holds it, a second is told who holds it, and release frees it", () => {
    const d = dir();
    try {
      const file = join(d, "daemon.lock");
      const first = acquire(file);
      expect("release" in first).toBe(true);
      expect(readFileSync(file, "utf8")).toBe(String(process.pid));
      // Another process asking: our pid is alive, so it is held.
      expect(acquire(file, process.pid + 1_000_000)).toEqual({ heldBy: process.pid });
      (first as { release(): void }).release();
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("a lock left by a process that is gone is taken over", () => {
    const d = dir();
    try {
      const file = join(d, "daemon.lock");
      writeFileSync(file, "999999999");
      const lock = acquire(file);
      expect("release" in lock).toBe(true);
      expect(readFileSync(file, "utf8")).toBe(String(process.pid));
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("a lock file with no pid in it is taken over", () => {
    const d = dir();
    try {
      const file = join(d, "daemon.lock");
      writeFileSync(file, "");
      expect("release" in acquire(file)).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("release leaves a lock that someone else has since taken", () => {
    const d = dir();
    try {
      const file = join(d, "daemon.lock");
      const lock = acquire(file) as { release(): void };
      writeFileSync(file, "12345");
      lock.release();
      expect(readFileSync(file, "utf8")).toBe("12345");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
