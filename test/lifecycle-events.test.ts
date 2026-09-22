import { describe, expect, test } from "bun:test";
import { DeskRegistry } from "../mod/desks.ts";
import { ScopeDebouncer, runtimeFromEvent } from "../mod/lifecycle-events.ts";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

describe("lifecycle event routing", () => {
  test("an agent's main chat resolves to its canonical desk", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-events-"));
    try {
      const runtime = runtimeFromEvent({ conversationId: "default", agentId: "agent-9" }, {});
      const desks = new DeskRegistry(join(dir, "desks.json"), dir);
      expect(desks.remember(runtime.conversationId!, runtime.agentId)).toBe("default-agent-9");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("event fields take precedence and context supplies missing fields", () => {
    expect(runtimeFromEvent({ conversationId: "event-conv", agentId: null }, { conversation: { id: "context-conv" } as never, agent: { id: "context-agent" } })).toEqual({
      conversationId: "event-conv",
      agentId: "context-agent",
    });
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
