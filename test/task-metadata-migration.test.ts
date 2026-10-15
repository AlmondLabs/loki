import { describe, expect, test } from "vitest";
import { metadataMigrationArgs, parseTask, TaskStore } from "../mod/tasks.ts";

/**
 * A task's metadata in beads, saved with camelCase keys before October 2026, reads under the snake_case names at once
 * and is rewritten in beads the first time the task list is read; tasks already on the new keys are left alone.
 */
const old = {
  id: "lk-a1",
  title: "migrate staging",
  status: "open",
  metadata: { by: "you", agentId: "a1", conversation: "c1", assignedTo: "c2", doneAsked: "yes", msgKey: "4295a0e4", lastNote: "half way" },
};

describe("task metadata from before snake_case", () => {
  test("reads under the new names, keeping the one-word keys as they are", () => {
    expect(parseTask(old).metadata).toEqual({
      by: "you",
      agent_id: "a1",
      conversation: "c1",
      assigned_to: "c2",
      done_asked: "yes",
      msg_key: "4295a0e4",
      last_note: "half way",
    });
  });

  test("is rewritten with one bd update: each value under its new key, the old key unset", () => {
    expect(metadataMigrationArgs(old)).toEqual([
      "update",
      "lk-a1",
      "--set-metadata",
      "agent_id=a1",
      "--unset-metadata",
      "agentId",
      "--set-metadata",
      "assigned_to=c2",
      "--unset-metadata",
      "assignedTo",
      "--set-metadata",
      "done_asked=yes",
      "--unset-metadata",
      "doneAsked",
      "--set-metadata",
      "msg_key=4295a0e4",
      "--unset-metadata",
      "msgKey",
      "--set-metadata",
      "last_note=half way",
      "--unset-metadata",
      "lastNote",
      "--json",
    ]);
    expect(metadataMigrationArgs({ ...old, metadata: { by: "you", agent_id: "a1" } })).toBeNull();
    // An id bd would read as an option is never passed along.
    expect(metadataMigrationArgs({ ...old, id: "--all" })).toBeNull();
  });

  test("the task list rewrites the old ones once, after listing, and reads every task under the new names", async () => {
    const calls: string[][] = [];
    const store = new TaskStore({
      dir: "/nonexistent",
      run: (args) => {
        calls.push(args);
        return Promise.resolve(
          args[0] === "list" ? JSON.stringify([old, { id: "lk-b2", title: "new", status: "open", metadata: { by: "you", agent_id: "a2" } }]) : "[]",
        );
      },
    });
    const tasks = await store.list();
    expect(tasks.map((t) => t.metadata.agent_id)).toEqual(["a1", "a2"]);
    expect(calls.map((c) => c.slice(0, 2))).toEqual([
      ["list", "--json"],
      ["update", "lk-a1"],
    ]);
  });
});
