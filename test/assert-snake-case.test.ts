import { describe, expect, test } from "vitest";
import { assertSnakeCase } from "./fixtures/frames.ts";

describe("the bridge tests' guard", () => {
  test("fails a frame with an old camelCase field, at any depth, and passes snake_case and user data", () => {
    expect(() => assertSnakeCase({ type: "chats", desks: [{ scope: "s", agentId: "a1" }] })).toThrow(
      "frame.desks[0].agentId is camelCase; on the wire it is agent_id",
    );
    expect(() => assertSnakeCase({ type: "chats", desks: [{ scope: "s", agent_id: "a1" }] })).not.toThrow();
    expect(() => assertSnakeCase({ type: "canvas", widgets: [{ data: { widgetId: "mine" } }] })).not.toThrow();
  });
});
