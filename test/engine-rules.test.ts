import { describe, expect, test } from "vitest";
import { DEFAULT_MODE, modeOf } from "../daemon/approvals.ts";
import { engineMoveRefused } from "../daemon/engine.ts";
import type { ChatEngine } from "../daemon/kernel/index.ts";

const onFake: ChatEngine = { kind: "acp", agent: "fake", model: "default", session_id: null };

describe("a chat's engine rules (plan 052)", () => {
  test("a chat's mode is the one stored for it, or the default when that is not a mode", () => {
    expect(modeOf("strict")).toBe("strict");
    expect(modeOf("acceptEdits")).toBe("acceptEdits");
    expect(modeOf(undefined)).toBe(DEFAULT_MODE);
    expect(modeOf("plan")).toBe(DEFAULT_MODE);
  });

  test("before its first message a chat moves anywhere; after it, only within its engine (plan 020, KD4)", () => {
    for (const [current, wanted] of [
      [null, "fake"],
      [onFake, null],
      [onFake, "other"],
    ] as const)
      expect(engineMoveRefused(current, wanted, false)).toBeNull();
    expect(engineMoveRefused(null, null, true)).toBeNull();
    expect(engineMoveRefused(onFake, "fake", true)).toBeNull();
    expect(engineMoveRefused(null, "fake", true)).toMatch(/started on another engine/);
    expect(engineMoveRefused(onFake, "other", true)).toMatch(/started on another engine/);
    expect(engineMoveRefused(onFake, null, true)).toMatch(/started on an ACP agent/);
  });
});
