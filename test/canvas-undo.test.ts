import { describe, expect, test } from "vitest";
import type { Gesture } from "../core/desk-core.ts";
import { takeUndo } from "../app/src/desk/use-desk.ts";

const move = (id: string): Gesture => ({ kind: "move", id, position: { x: 0, y: 0 } });

describe("undo on the canvas", () => {
  test("takes the newest step of the canvas in view, or a shared widget's; another chat's steps wait there", () => {
    const stack = [move("conv-a/w1"), move("shared/clock"), move("conv-b/w2")];
    expect(takeUndo(stack, "conv-a")?.id).toBe("shared/clock");
    expect(takeUndo(stack, "conv-a")?.id).toBe("conv-a/w1");
    expect(takeUndo(stack, "conv-a")).toBeNull();
    expect(stack.map((g) => g.id)).toEqual(["conv-b/w2"]);
  });
});
