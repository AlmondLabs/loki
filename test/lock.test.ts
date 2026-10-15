import { describe, expect, test } from "vitest";
import { spawn } from "node:child_process";
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

  test("daemons starting at once on a leftover: exactly one wins", async () => {
    const d = dir();
    try {
      const file = join(d, "daemon.lock");
      // A file: URL, not a path: Windows' C:\\… is no import specifier.
      const lock = new URL("../daemon/lock.ts", import.meta.url).href;
      for (let round = 0; round < 3; round++) {
        writeFileSync(file, "999999999"); // a crashed daemon's
        // All of them reach acquire in the same millisecond, past their start-up, where the race is.
        const at = Date.now() + 1500;
        const script = `import { acquire } from ${JSON.stringify(lock)}; while (Date.now() < ${at}); const l = acquire(${JSON.stringify(file)}); console.log("release" in l ? "won" : "held"); setTimeout(() => {}, 3000);`;
        const children: Array<ReturnType<typeof spawn>> = [];
        const runs = Array.from(
          { length: 12 },
          () =>
            new Promise<string>((resolve) => {
              const c = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script]);
              children.push(c);
              let out = "";
              let err = "";
              c.stderr.on("data", (b: Buffer) => (err += b.toString()));
              // Each stays alive until all have answered: a winner that exited would leave a leftover to take over.
              c.stdout.on("data", (b: Buffer) => {
                out += b.toString();
                if (out.includes("\n")) resolve(out.trim());
              });
              c.on("exit", () => resolve(out.trim() || `exited: ${err.trim().split("\n")[0]}`));
            }),
        );
        const results = await Promise.all(runs);
        for (const c of children) c.kill();
        await Promise.all(children.map((c) => new Promise((r) => (c.exitCode !== null || c.signalCode !== null ? r(null) : c.once("exit", r)))));
        expect(
          results.filter((r) => r === "won"),
          results.join(","),
        ).toHaveLength(1);
      }
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, 30_000);
});
