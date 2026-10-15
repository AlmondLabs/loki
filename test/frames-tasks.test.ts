import { describe, expect, test } from "vitest";
import type { Task } from "../core/frame-types.ts";
import type { TaskStore } from "../mod/tasks.ts";
import type { RecallStore } from "../mod/recall.ts";
import { bridgeWith, client, settled } from "./fixtures/frames.ts";

const task = (id: string, status = "open"): Task => ({
  id,
  title: id,
  description: "",
  status,
  priority: 2,
  labels: [],
  assignee: null,
  created_at: "",
  updated_at: "",
  closed_at: null,
  metadata: {},
});

describe("tasks and Learn frames", () => {
  test("an assign without its chat is refused; one with it replies the tasks and tells other tabs", async () => {
    const assigned: Array<{ ids: string[]; status: string }> = [];
    const store = {
      assign: (ids: string[], _t: unknown, status: string) => (assigned.push({ ids, status }), Promise.resolve(ids.map((id) => task(id, status)))),
    } as unknown as TaskStore;
    const { bridge, broadcasts } = bridgeWith({ tasks: store });
    const c = client("d1");
    bridge.onMessage(c, { type: "task_assign", request_id: "r1", ids: ["t1"], conversation_id: "conv-1" });
    expect(c.sent.at(-1)).toEqual({ type: "error", request_id: "r1", message: "assign needs a conversation and a chat" });
    bridge.onMessage(c, { type: "task_assign", request_id: "r2", ids: ["t1"], conversation_id: "conv-1", desk: "conv-1", start: true });
    await settled();
    expect(c.sent.at(-1)).toMatchObject({ type: "tasks_updated", request_id: "r2", tasks: [{ id: "t1", status: "in_progress" }] });
    expect(assigned).toEqual([{ ids: ["t1"], status: "in_progress" }]);
    expect(broadcasts.at(-1)?.frame).toEqual({ type: "tasks_changed" });
  });

  test("reopen takes back an agent's done? (or a done task) and tells other tabs", async () => {
    const reopened: string[][] = [];
    const store = { reopen: (ids: string[]) => (reopened.push(ids), Promise.resolve(ids.map((id) => task(id)))) } as unknown as TaskStore;
    const { bridge, broadcasts } = bridgeWith({ tasks: store });
    const c = client("d1");
    bridge.onMessage(c, { type: "task_reopen", request_id: "r1", ids: ["lk-a1", "lk-b2"] });
    await settled();
    expect(c.sent.at(-1)).toMatchObject({ type: "tasks_updated", request_id: "r1", tasks: [{ id: "lk-a1" }, { id: "lk-b2" }] });
    expect(reopened).toEqual([["lk-a1", "lk-b2"]]);
    expect(broadcasts.at(-1)?.frame).toEqual({ type: "tasks_changed" });
  });

  test("a lesson that cannot start answers error with the reason", async () => {
    const store = {} as RecallStore;
    const { bridge } = bridgeWith({
      recall: {
        store,
        status: () => ({ enabled: false, daily_cap: 5, last_run_at: null, last_run_note: null, written_today: 0 }),
        setSettings: async () => {},
        run: () => Promise.resolve({ note: "" }),
        startLesson: () => Promise.reject(new Error("no agent for this lead")),
      },
    });
    const c = client("d1");
    bridge.onMessage(c, { type: "recall_lead_start", request_id: "r1", id: "lead-1" });
    await settled();
    expect(c.sent.at(-1)).toEqual({ type: "error", request_id: "r1", message: "no agent for this lead" });
  });
});
