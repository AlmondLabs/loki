import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassState } from "../daemon/passes-state.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "loki-passes-state-"));
  return { state: () => new PassState(join(dir, "state")), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("background passes: the first start", () => {
  test("starts every chat's cursors where the chat is now, for both jobs, and keeps them", () => {
    const s = setup();
    try {
      const state = s.state();
      expect(state.started()).toBe(false);
      state.startCursors([
        { agentId: "agent-a", chatId: "c1", entries: 5 },
        { agentId: "agent-b", chatId: "c2", entries: 12 },
      ]);
      expect(state.cursor("reflection", "agent-a", "c1")).toBe(5);
      expect(state.cursor("learn", "agent-a", "c1")).toBe(5);
      expect(state.cursor("reflection", "agent-b", "c2")).toBe(12);
      expect(state.cursor("learn", "agent-b", "c2")).toBe(12);
      const again = s.state();
      expect(again.started()).toBe(true);
      expect(again.cursor("reflection", "agent-b", "c2")).toBe(12);
    } finally {
      s.cleanup();
    }
  });

  test("a later start leaves the cursors as the passes moved them", () => {
    const s = setup();
    try {
      s.state().startCursors([{ agentId: "agent-a", chatId: "c1", entries: 5 }]);
      s.state().setCursor("reflection", "agent-a", "c1", 9);
      expect(s.state().started()).toBe(true);
      expect(s.state().cursor("reflection", "agent-a", "c1")).toBe(9);
    } finally {
      s.cleanup();
    }
  });

  test("with nothing saved, reflection is on, Learn is off at 5 a day, and the ACP fallback is on", () => {
    const s = setup();
    try {
      expect(s.state().settings()).toEqual({ reflection: { enabled: true }, learn: { enabled: false, daily_cap: 5 }, acp: { enabled: true } });
    } finally {
      s.cleanup();
    }
  });
});
