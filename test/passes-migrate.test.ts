import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassState } from "../daemon/passes-state.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "loki-passes-migrate-"));
  const old = { reflectionSettings: join(dir, "state", "reflection.json"), reflectionRoot: join(dir, "reflection"), learnWorker: join(dir, "recall", "worker.json") };
  const write = (file: string, value: unknown) => {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify(value));
  };
  return { dir, old, write, state: () => new PassState(join(dir, "state")), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("background passes: the first start carries over what reflection and Learn kept", () => {
  test("reflection off stays off, any other trigger is on", () => {
    for (const [trigger, enabled] of [["off", false], ["step-count", true], ["compaction-event", true]] as const) {
      const s = setup();
      try {
        s.write(s.old.reflectionSettings, { trigger, stepCount: 25 });
        const state = s.state();
        state.migrate(s.old, []);
        expect(state.settings().reflection.enabled).toBe(enabled);
      } finally {
        s.cleanup();
      }
    }
  });

  test("Learn's old default cap of 25 becomes 5, a cap the person chose stays, and Learn on stays on", () => {
    for (const [cap, expected] of [[25, 5], [8, 8], [undefined, 5]] as const) {
      const s = setup();
      try {
        s.write(s.old.learnWorker, { enabled: true, ...(cap === undefined ? {} : { dailyCap: cap }) });
        const state = s.state();
        state.migrate(s.old, []);
        expect(state.settings().learn).toEqual({ enabled: true, dailyCap: expected });
      } finally {
        s.cleanup();
      }
    }
  });

  test("cursors carry over; a chat neither job has read starts where it is now, and today's card count carries", () => {
    const s = setup();
    try {
      s.write(join(s.old.reflectionRoot, "agent-a", "c1", "state.json"), { reflected_through: 40, total_completed_steps: 30 });
      // Letta's state files carry counters but no cursor.
      s.write(join(s.old.reflectionRoot, "agent-a", "c2", "state.json"), { total_completed_steps: 12 });
      s.write(s.old.learnWorker, { enabled: false, cursors: { "agent-a/c1": 33 }, leadCursors: { "agent-a/c1": 50 }, written: { day: "2026-10-10", count: 3 } });
      const state = s.state();
      state.migrate(s.old, [
        { agentId: "agent-a", chatId: "c1", entries: 60 },
        { agentId: "agent-a", chatId: "c2", entries: 20 },
        { agentId: "agent-b", chatId: "c3", entries: 7 },
      ]);
      expect(state.cursor("reflection", "agent-a", "c1")).toBe(40);
      expect(state.cursor("learn", "agent-a", "c1")).toBe(33);
      expect(state.cursor("reflection", "agent-a", "c2")).toBe(20);
      expect(state.cursor("learn", "agent-a", "c2")).toBe(20);
      expect(state.cursor("reflection", "agent-b", "c3")).toBe(7);
      expect(state.cursor("learn", "agent-b", "c3")).toBe(7);
      expect(state.writtenOn("2026-10-10")).toBe(3);
      // What was kept is read back by a fresh state, as after a restart.
      expect(s.state().cursor("reflection", "agent-a", "c1")).toBe(40);
    } finally {
      s.cleanup();
    }
  });

  test("a start with the passes' settings present does not carry over again, and the old files are left as they were", () => {
    const s = setup();
    try {
      s.write(s.old.reflectionSettings, { trigger: "off" });
      s.write(s.old.learnWorker, { enabled: true, dailyCap: 25 });
      const first = s.state();
      expect(first.started()).toBe(false);
      first.migrate(s.old, []);
      expect(s.state().started()).toBe(true);
      expect(JSON.parse(readFileSync(s.old.reflectionSettings, "utf8"))).toEqual({ trigger: "off" });
      expect(JSON.parse(readFileSync(s.old.learnWorker, "utf8"))).toEqual({ enabled: true, dailyCap: 25 });
    } finally {
      s.cleanup();
    }
  });

  test("with nothing to carry over, reflection is on and Learn is off at 5 a day", () => {
    const s = setup();
    try {
      const state = s.state();
      state.migrate(s.old, []);
      expect(state.settings()).toEqual({ reflection: { enabled: true }, learn: { enabled: false, dailyCap: 5 } });
    } finally {
      s.cleanup();
    }
  });
});
