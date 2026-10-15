import { describe, expect, test } from "vitest";
import { OLD_KEYS, migrateKeys } from "../core/snake-keys.ts";
import { assertSnakeCase } from "./fixtures/frames.ts";

/** Data saved camelCase before October 2026 reads as snake_case, renaming only the fields loki knew, never ids. */
describe("migrateKeys", () => {
  test("renames the old field names at any depth, in arrays too, and says it changed something", () => {
    const old = { agentId: "a1", source: { conversationId: "c1", agentName: "Friday" }, cards: [{ createdAt: "2026-10-01" }] };
    expect(migrateKeys(old)).toEqual({
      value: { agent_id: "a1", source: { conversation_id: "c1", agent_name: "Friday" }, cards: [{ created_at: "2026-10-01" }] },
      changed: true,
    });
  });

  test("leaves keys it does not know, ids with capitals among them, and reports no change on new data", () => {
    const widgets = { "c1/MyWidget": { title: "x" }, "shared/sleepTracker": { agent_id: "a1" } };
    expect(migrateKeys(widgets)).toEqual({ value: widgets, changed: false });
    expect(migrateKeys({ agent_id: "a1", tasks: [] })).toEqual({ value: { agent_id: "a1", tasks: [] }, changed: false });
  });

  test("when both spellings are there, the snake_case one wins", () => {
    expect(migrateKeys({ agentId: "old", agent_id: "new" }).value).toEqual({ agent_id: "new" });
    expect(migrateKeys({ agent_id: "new", agentId: "old" }).value).toEqual({ agent_id: "new" });
  });

  test("plain values pass through, and every renamed name is snake_case", () => {
    expect(migrateKeys("text")).toEqual({ value: "text", changed: false });
    expect(migrateKeys(null)).toEqual({ value: null, changed: false });
    for (const [from, to] of Object.entries(OLD_KEYS)) {
      expect(from, from).toMatch(/^[a-z]+[A-Z]/);
      expect(to, from).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/);
    }
  });
});

describe("the bridge tests' guard", () => {
  test("fails a frame with an old camelCase field, at any depth, and passes snake_case and user data", () => {
    expect(() => assertSnakeCase({ type: "desks", desks: [{ scope: "s", agentId: "a1" }] })).toThrow(
      "frame.desks[0].agentId is camelCase; on the wire it is agent_id",
    );
    expect(() => assertSnakeCase({ type: "desks", desks: [{ scope: "s", agent_id: "a1" }] })).not.toThrow();
    // A widget's data is the agent's own JSON, and a task's metadata is checked by its own migration.
    expect(() => assertSnakeCase({ type: "desk", widgets: [{ data: { widgetId: "mine" } }] })).not.toThrow();
  });
});
