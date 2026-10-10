import { describe, expect, test } from "vitest";
import type { Task } from "../core/frame-types.ts";
import type { TaskBoard } from "../mod/tasks.ts";
import type { RecallStore } from "../mod/recall.ts";
import { bridgeWith, client, settled } from "./fixtures/frames.ts";

const task = (id: string, status = "open"): Task => ({ id, title: id, description: "", status, priority: 2, labels: [], assignee: null, createdAt: "", updatedAt: "", closedAt: null, metadata: {} });

describe("board and Learn frames", () => {
  test("an assign without its chat is refused; one with it replies the tasks and tells other tabs", async () => {
    const assigned: Array<{ ids: string[]; status: string }> = [];
    const board = { assign: async (ids: string[], _t: unknown, status: string) => (assigned.push({ ids, status }), ids.map((id) => task(id, status))) } as unknown as TaskBoard;
    const { bridge, broadcasts } = bridgeWith({ tasks: board });
    const c = client("d1");
    bridge.onMessage(c, { type: "task_assign", requestId: "r1", ids: ["t1"], conversationId: "conv-1" });
    expect(c.sent.at(-1)).toEqual({ type: "error", requestId: "r1", message: "assign needs a conversation and a chat" });
    bridge.onMessage(c, { type: "task_assign", requestId: "r2", ids: ["t1"], conversationId: "conv-1", desk: "conv-1", start: true });
    await settled();
    expect(c.sent.at(-1)).toMatchObject({ type: "tasks_updated", requestId: "r2", tasks: [{ id: "t1", status: "in_progress" }] });
    expect(assigned).toEqual([{ ids: ["t1"], status: "in_progress" }]);
    expect(broadcasts.at(-1)?.frame).toEqual({ type: "tasks_changed" });
  });

  test("a lesson that cannot start answers error with the reason", async () => {
    const store = {} as RecallStore;
    const { bridge } = bridgeWith({ recall: { store, status: () => ({ enabled: false, dailyCap: 5, lastRunAt: null, lastRunNote: null, writtenToday: 0 }), setSettings: async () => {}, run: async () => ({ note: "" }), startLesson: async () => { throw new Error("no agent for this lead"); } } });
    const c = client("d1");
    bridge.onMessage(c, { type: "recall_lead_start", requestId: "r1", id: "lead-1" });
    await settled();
    expect(c.sent.at(-1)).toEqual({ type: "error", requestId: "r1", message: "no agent for this lead" });
  });
});
