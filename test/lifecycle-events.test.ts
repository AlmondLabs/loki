import { describe, expect, test } from "vitest";
import { DeskRegistry } from "../mod/desks.ts";
import { ScopeDebouncer } from "../mod/lifecycle-events.ts";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

describe("lifecycle event routing", () => {
  test("an agent's main chat resolves to its canonical desk", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-events-"));
    try {
      const desks = new DeskRegistry(join(dir, "desks.json"), () => null);
      expect(desks.remember("default", "agent-9")).toBe("default-agent-9");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("debounces each desk independently and clears pending work", () => {
    let nextId = 0;
    const pending = new Map<number, () => void>();
    const debouncer = new ScopeDebouncer(
      (callback) => {
        const id = ++nextId;
        pending.set(id, () => {
          pending.delete(id);
          callback();
        });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      (id) => pending.delete(id as unknown as number),
    );
    const fired: string[] = [];

    debouncer.schedule("desk-a", () => fired.push("old-a"), 1200);
    debouncer.schedule("desk-b", () => fired.push("b"), 1200);
    debouncer.schedule("desk-a", () => fired.push("new-a"), 1200);
    for (const callback of [...pending.values()]) callback();

    expect(fired).toEqual(["b", "new-a"]);
    debouncer.schedule("desk-c", () => fired.push("c"), 1200);
    debouncer.clear();
    expect(pending.size).toBe(0);
  });
});
