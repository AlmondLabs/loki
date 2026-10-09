import { describe, expect, test } from "bun:test";
import { FRAMES, PHONE_FRAMES, frameEntry, type FrameName } from "../core/frames.ts";

const names = Object.keys(FRAMES) as FrameName[];
const parsed = names.filter((n) => FRAMES[n].kind !== "push");

describe("the frame table", () => {
  test("a paired phone may send exactly the frames it could before the table", () => {
    expect([...PHONE_FRAMES].sort() as string[]).toEqual(
      ["capture", "list_desks", "seen_list", "seen_mark", "seen_unmark", "viewed_mark", "history_get", "inbox_list", "pin_set", "folders_get", "agent_get", "memory_read", "memory_log", "memory_diff", "recall_list", "recall_grade", "recall_reject", "recall_restore", "recall_edit", "recall_export", "recall_lead_start", "recall_lead_dismiss", "recall_lead_restore", "models_recent_add", "focus_add", "desk_get"].sort(),
    );
  });

  test("every reply the app waited for is some request's reply", () => {
    const replies = new Set(names.flatMap((n) => (FRAMES[n].kind === "request" ? [(FRAMES[n] as { reply: string }).reply] : [])));
    for (const r of ["agent", "memory_file", "memory_commits", "memory_diff", "reflection_state", "tasks", "task_created", "tasks_updated", "history", "folders", "folder_matches", "folder_status", "folder_picked", "skills_global", "skill_installed", "skill_refreshed", "inbox", "recall", "recall_card", "recall_ran", "recall_export", "recall_lesson"]) {
      expect([r, replies.has(r)]).toEqual([r, true]);
    }
  });

  test("an unknown or inherited name is no frame", () => {
    expect(frameEntry("no_such_frame")).toBeUndefined();
    expect(frameEntry("toString")).toBeUndefined();
    expect(frameEntry(undefined)).toBeUndefined();
    expect(frameEntry("history_get")?.kind).toBe("request");
  });

  test("every parser answers anything with a payload or a message, never a throw", () => {
    const junk: Array<Record<string, unknown>> = [{}, { id: 7, agentId: "../x", conversationId: null, size: "big", gesture: [], grade: "3", ids: "a", properties: [1] }, { id: null, scope: "", path: {}, event: "Not An Event" }];
    for (const n of parsed) {
      const parse = (FRAMES[n] as { parse: (m: Record<string, unknown>) => unknown }).parse;
      for (const m of junk) {
        const r = parse(m);
        expect([n, typeof r === "string" || (typeof r === "object" && r !== null)]).toEqual([n, true]);
      }
    }
  });

  test("parsers keep today's checks", () => {
    expect(FRAMES.recall_grade.parse({ id: "c1", grade: 5 })).toBe("a grade is 1 (again) to 4 (easy)");
    expect(FRAMES.recall_grade.parse({ id: "c1", grade: 3 })).toEqual({ id: "c1", grade: 3 });
    expect(FRAMES.history_get.parse({ agentId: "a" })).toBe("conversationId required");
    expect(FRAMES.history_get.parse({ conversationId: "c", limit: 99999 })).toEqual({ agentId: null, conversationId: "c", limit: 99999 });
    expect(FRAMES.task_assign.parse({ ids: ["t1"], conversationId: "c" })).toBe("assign needs a conversation and a chat");
    expect(FRAMES.task_status.parse({ id: "t1", status: "open" })).toEqual({ ids: ["t1"], status: "open" });
    expect(FRAMES.task_status.parse({ id: "t1", status: "done" })).toBe("unknown status done");
    expect(FRAMES.memory_read.parse({ agentId: "../etc" })).toBe("agentId required");
    expect(FRAMES.lan_via_set.parse({ via: "bluetooth" })).toBe('via must be "tailscale" or "lan"');
    expect(FRAMES.focus_add.parse({ conversationId: "c", action: "open" })).toBe("action must be answer, decide or skip");
    expect(FRAMES.capture.parse({ event: "desk_switched", properties: [1] })).toEqual({ event: "desk_switched", properties: undefined });
    expect(FRAMES.gesture.parse({ gesture: { id: "d/w", kind: "move", position: { x: 1, y: 2 } } })).toEqual({ gesture: { id: "d/w", kind: "move", position: { x: 1, y: 2 } } });
    expect(FRAMES.folder_complete.parse({})).toEqual({ prefix: null });
  });
});
