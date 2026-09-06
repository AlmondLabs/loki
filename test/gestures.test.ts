import { describe, expect, test } from "bun:test";
import { GestureLog, attachDeskContext, describeGesture, formatDeskContext } from "../mod/gestures.ts";
import type { WidgetManifestEntry } from "../shared/desk-core.ts";

const entry: WidgetManifestEntry = {
  id: "c1/sleep", scope: "c1", name: "sleep", kind: "json", file: "c1/sleep.json", title: "Sleep", type: "slider-control",
  data: { value: 6 }, hash: "abc", updatedAt: 0,
};

describe("describeGesture", () => {
  test("move/close/set produce lines; focus is silent", () => {
    expect(describeGesture({ kind: "focus", id: "c1/sleep" }, entry)).toBeNull();
    expect(describeGesture({ kind: "move", id: "c1/sleep", position: { x: 10.4, y: 20.6 } }, entry)!.line).toBe(
      'moved "Sleep" (c1/sleep) to (10, 21)',
    );
    expect(describeGesture({ kind: "close", id: "c1/sleep" }, entry)!.line).toMatch(/^minimised "Sleep" \(c1\/sleep\)/);
    expect(describeGesture({ kind: "open", id: "c1/sleep" }, entry)!.line).toBe('restored "Sleep" (c1/sleep) from the tray');
    expect(describeGesture({ kind: "set", id: "c1/sleep", path: "value", value: 7 }, entry, { value: 6 })!.line).toBe(
      'set value = 7 (was 6) on "Sleep" (c1/sleep)',
    );
    expect(describeGesture({ kind: "set", id: "x/y", path: "a.b", value: "z" }, undefined)!.line).toBe('set a.b = "z" on "x/y"');
  });
});

describe("GestureLog", () => {
  test("collapses consecutive same-key entries, drains per scope", () => {
    const log = new GestureLog();
    log.record("c1", "moved A to (1, 1)", "move:A");
    log.record("c1", "moved A to (2, 2)", "move:A");
    log.record("c1", "set v = 1 on A", "set:A:v");
    log.record("shared", "closed B", "close:B");
    expect(log.peek("c1")).toEqual(["moved A to (2, 2)", "set v = 1 on A"]);
    expect(log.drain("c1")).toEqual(["moved A to (2, 2)", "set v = 1 on A"]);
    expect(log.peek("c1")).toEqual([]);
    expect(log.peek("shared")).toEqual(["closed B"]);
  });
});

describe("attachDeskContext", () => {
  const block = formatDeskContext("c1", ["moved A"]);
  test("block format", () => {
    expect(block.startsWith('<loki-desk desk="c1">')).toBe(true);
    expect(block).toContain("- moved A");
    expect(block.endsWith("</loki-desk>")).toBe(true);
  });
  test("appends to the last user message (string content)", () => {
    const out = attachDeskContext([{ type: "message", role: "user", content: "hi" }], block);
    expect(out[0].content).toBe(`hi\n\n${block}`);
  });
  test("appends a text part for array content; skips approval items; leaves input untouched otherwise", () => {
    const input = [
      { type: "message", role: "user", content: [{ type: "text", text: "a" }] },
      { type: "approval", approve: true },
    ];
    const out = attachDeskContext(input, block);
    expect((out[0].content as unknown[]).length).toBe(2);
    expect(out[1]).toBe(input[1]);
    expect(input[0].content).toHaveLength(1); // not mutated
    expect(attachDeskContext([{ type: "approval" }], block)).toEqual([{ type: "approval" }]);
  });
});
