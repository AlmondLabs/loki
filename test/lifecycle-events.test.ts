import { describe, expect, test, vi } from "vitest";
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
    vi.useFakeTimers();
    try {
      const debouncer = new ScopeDebouncer(1200);
      const fired: string[] = [];
      debouncer.schedule("desk-a", () => fired.push("old-a"));
      debouncer.schedule("desk-b", () => fired.push("b"));
      vi.advanceTimersByTime(600);
      debouncer.schedule("desk-a", () => fired.push("new-a")); // desk-a's clock starts again; desk-b's does not
      vi.advanceTimersByTime(600);
      expect(fired).toEqual(["b"]);
      vi.advanceTimersByTime(600);
      expect(fired).toEqual(["b", "new-a"]);
      debouncer.schedule("desk-c", () => fired.push("c"));
      debouncer.clear();
      vi.advanceTimersByTime(2000);
      expect(fired).toEqual(["b", "new-a"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
