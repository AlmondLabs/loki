import { describe, expect, test } from "bun:test";
import { applyGesture, applyMeasure, arrangeLayout, clearOverlay, emptyDesk, ensureLayout, findFreeSpot, forgetWidget, mergeData, occupiedRects, reveal, scopeFor, type Rect } from "../packages/core/src/desk-core.ts";

const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

describe("desk-core reducer", () => {
  test("ensureLayout places unknown widgets in free space and is idempotent", () => {
    const a = ensureLayout(emptyDesk("d"), "d/x");
    expect(a.layout["d/x"].position).toEqual({ x: 120, y: 120 });
    expect(a.layout["d/x"].z).toBe(1);
    expect(ensureLayout(a, "d/x")).toBe(a);
    const b = ensureLayout(a, "d/y");
    expect(b.layout["d/y"].position).toEqual({ x: 424, y: 120 }); // to the right, one gap over
    // ten widgets never overlap and wrap onto new rows
    let s = emptyDesk("d");
    for (let i = 0; i < 10; i++) s = ensureLayout(s, `d/w${i}`);
    const rects = occupiedRects(s);
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(overlap(rects[i], rects[j])).toBe(false);
    expect(Math.max(...rects.map((r) => r.x + r.w))).toBeLessThanOrEqual(120 + 1280);
    expect(new Set(rects.map((r) => r.y)).size).toBeGreaterThan(1);
  });

  test("findFreeSpot respects obstacles from another desk and measured sizes", () => {
    const shared: Rect[] = [{ x: 120, y: 120, w: 280, h: 300 }];
    const p = findFreeSpot(shared, { w: 280, h: 100 });
    expect(overlap({ ...p, w: 280, h: 100 }, shared[0])).toBe(false);
    expect(p).toEqual({ x: 424, y: 120 });
    // a very wide widget that cannot share the row starts a new row below everything
    const wide = findFreeSpot(shared, { w: 1280, h: 100 });
    expect(wide).toEqual({ x: 120, y: 444 });
  });

  test("applyMeasure records size once and ignores jitter", () => {
    let s = ensureLayout(emptyDesk("d"), "d/x");
    s = applyMeasure(s, "d/x", { w: 280.4, h: 212.6 });
    expect(s.layout["d/x"].size).toEqual({ w: 280, h: 213 });
    expect(applyMeasure(s, "d/x", { w: 281, h: 213 })).toBe(s);
    expect(applyMeasure(s, "d/none", { w: 1, h: 1 })).toBe(s);
  });

  test("arrangeLayout packs stacked widgets into a non-overlapping grid around fixed rects", () => {
    let s = emptyDesk("d");
    for (let i = 0; i < 5; i++) s = applyGesture(s, { kind: "move", id: `d/w${i}`, position: { x: 140 + i * 30, y: 120 + i * 24 } }); // the old cascade
    s = applyMeasure(s, "d/w2", { w: 280, h: 320 });
    const fixed: Rect[] = [{ x: 120, y: 120, w: 280, h: 160 }];
    const t = arrangeLayout(s, fixed);
    const rects = [...fixed, ...occupiedRects(t)];
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(overlap(rects[i], rects[j])).toBe(false);
    expect(t.rev).toBe(s.rev + 1);
    expect(arrangeLayout(emptyDesk("e"))).toEqual(emptyDesk("e"));
  });

  test("move / focus / close are immutable and bump rev", () => {
    const s0 = ensureLayout(ensureLayout(emptyDesk("d"), "d/a"), "d/b");
    const s1 = applyGesture(s0, { kind: "move", id: "d/a", position: { x: 5, y: 6 } });
    expect(s1).not.toBe(s0);
    expect(s0.layout["d/a"].position).toEqual({ x: 120, y: 120 });
    expect(s1.layout["d/a"].position).toEqual({ x: 5, y: 6 });
    expect(s1.rev).toBe(s0.rev + 1);
    const s2 = applyGesture(s1, { kind: "focus", id: "d/a" });
    expect(s2.layout["d/a"].z).toBe(3);
    const s3 = applyGesture(s2, { kind: "focus", id: "d/a" });
    expect(s3.layout["d/a"].z).toBe(3); // already on top: no bump
    const s4 = applyGesture(s3, { kind: "close", id: "d/b" });
    expect(s4.layout["d/b"].hidden).toBe(true);
  });

  test("open undoes close and brings the widget to the front", () => {
    let s = ensureLayout(ensureLayout(emptyDesk("d"), "d/a"), "d/b");
    s = applyGesture(s, { kind: "close", id: "d/a" });
    expect(s.layout["d/a"].hidden).toBe(true);
    s = applyGesture(s, { kind: "open", id: "d/a" });
    expect(s.layout["d/a"].hidden).toBe(false);
    expect(s.layout["d/a"].z).toBe(3);
  });

  test("move on an unseen widget creates its layout", () => {
    const s = applyGesture(emptyDesk("d"), { kind: "move", id: "d/new", position: { x: 1, y: 2 } });
    expect(s.layout["d/new"]).toEqual({ position: { x: 1, y: 2 }, z: 1 });
  });

  test("set writes the overlay; mergeData applies it over file data without mutating", () => {
    const s = applyGesture(emptyDesk("d"), { kind: "set", id: "d/w", path: "items.1.done", value: true });
    expect(s.overlay["d/w"]).toEqual({ "items.1.done": true });
    const file = { items: [{ text: "a" }, { text: "b" }] };
    const merged = mergeData(file, s.overlay["d/w"]);
    expect(merged).toEqual({ items: [{ text: "a" }, { text: "b", done: true }] });
    expect(file.items[1]).toEqual({ text: "b" });
  });

  test("clearOverlay and reveal", () => {
    let s = applyGesture(emptyDesk("d"), { kind: "set", id: "d/w", path: "v", value: 1 });
    s = applyGesture(s, { kind: "close", id: "d/w" });
    const cleared = reveal(clearOverlay(s, "d/w"), "d/w");
    expect(cleared.overlay["d/w"]).toBeUndefined();
    expect(cleared.layout["d/w"].hidden).toBe(false);
    expect(clearOverlay(cleared, "d/w")).toBe(cleared);
  });

  test("forgetWidget drops layout and overlay", () => {
    let s = applyGesture(ensureLayout(emptyDesk("d"), "d/w"), { kind: "set", id: "d/w", path: "v", value: 1 });
    const t = forgetWidget(s, "d/w");
    expect(t.layout["d/w"]).toBeUndefined();
    expect(t.overlay["d/w"]).toBeUndefined();
    expect(forgetWidget(t, "d/w")).toBe(t);
  });

  test("scopeFor sanitizes conversation ids and keys default chats by agent", () => {
    expect(scopeFor(null)).toBe("shared");
    expect(scopeFor("conv-abc/../x y")).toBe("conv-abc____x_y");
    expect(scopeFor("default", "agent-local-1")).toBe("default-agent-local-1");
    expect(scopeFor("default", "agent-local-2")).not.toBe(scopeFor("default", "agent-local-1"));
    expect(scopeFor("default")).toBe("default");
  });
});

describe("applyMeasure guards", () => {
  test("a collapsed frame (a few px wide) is never persisted as the widget's size", () => {
    const { applyMeasure, emptyDesk, ensureLayout } = require("../packages/core/src/desk-core.ts");
    let state = ensureLayout(emptyDesk("d"), "d/a", []);
    const before = state.layout["d/a"].size;
    expect(applyMeasure(state, "d/a", { w: 2, h: 900 })).toBe(state);
    expect(applyMeasure(state, "d/a", { w: 300, h: 20 })).toBe(state);
    state = applyMeasure(state, "d/a", { w: 300, h: 200 });
    expect(state.layout["d/a"].size).toEqual({ w: 300, h: 200 });
    expect(before).not.toEqual({ w: 300, h: 200 });
  });
});

describe("frame sizing", () => {
  test("a resize gesture pins the size and marks the frame user-sized", () => {
    let st = ensureLayout(emptyDesk("s"), "s/a");
    st = applyGesture(st, { kind: "resize", id: "s/a", size: { w: 500, h: 300 } });
    expect(st.layout["s/a"].size).toEqual({ w: 500, h: 300 });
    expect(st.layout["s/a"].sized).toBe(true);
  });
  test("measuring content never marks a frame user-sized (it stays auto)", () => {
    let st = ensureLayout(emptyDesk("s"), "s/b");
    st = applyMeasure(st, "s/b", { w: 420, h: 260 });
    expect(st.layout["s/b"].size).toEqual({ w: 420, h: 260 });
    expect(st.layout["s/b"].sized).toBeUndefined();
  });
});
