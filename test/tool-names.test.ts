import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Approvals } from "../daemon/approvals.ts";
import { RENAMED_TOOLS, SPLIT_TOOLS, renameToolsIn, renamedCall } from "../daemon/tool-kinds.ts";

/** loki's tools under their names now, and every old name moving to one (plan 044). */
describe("loki's tool names, old and now", () => {
  test("every name now is <subject>_<verb> or one word, and no old name is a name now", () => {
    const now = [...Object.values(RENAMED_TOOLS), ...Object.values(SPLIT_TOOLS).flatMap((s) => Object.values(s ?? {}))];
    expect(now.filter((n) => !n || !/^[a-z][a-z0-9]*(_[a-z0-9]+)?$/.test(n))).toEqual([]);
    expect(now.filter((n) => n && (n in RENAMED_TOOLS || n in SPLIT_TOOLS))).toEqual([]);
  });

  test("a call takes its name now; a split tool's, its action's tool without the action; a current name is left", () => {
    expect(renamedCall("desk_camera", { widget_id: "c/a" })).toEqual({ name: "canvas_focus", args: { widget_id: "c/a" } });
    expect(renamedCall("tasks", { action: "comment", id: "lk-1", text: "half" })).toEqual({ name: "task_comment", args: { id: "lk-1", text: "half" } });
    expect(renamedCall("loki_task", { action: "list" })).toEqual({ name: "task_list", args: {} });
    expect(renamedCall("tasks", { action: "fly" })).toBeNull();
    expect(renamedCall("canvas_read", {})).toBeNull();
  });

  test("a result follows its call by id; one whose call was not seen takes a plain rename", () => {
    const calls = new Map<string, string>();
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "on it" },
          { type: "toolCall", id: "t1", name: "tasks", arguments: { action: "close", id: "lk-1" } },
        ],
      },
      { role: "toolResult", toolCallId: "t1", toolName: "tasks", content: [] },
      { role: "toolResult", toolCallId: "elsewhere", toolName: "view_image", content: [] },
      { role: "toolResult", toolCallId: "t9", toolName: "bash", content: [] },
    ];
    expect(renameToolsIn(messages, calls)).toBe(true);
    expect(messages[0].content[1]).toEqual({ type: "toolCall", id: "t1", name: "task_close", arguments: { id: "lk-1" } });
    expect(messages.slice(1).map((m) => m.toolName)).toEqual(["task_close", "image_view", "bash"]);
    expect(renameToolsIn(messages, calls)).toBe(false);
  });

  test("the always-allow list carries over once: a renamed tool to its name, a split one to each of its tools", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-always-names-"));
    try {
      const alwaysPath = join(dir, "state", "approvals.json");
      mkdirSync(join(dir, "state"));
      writeFileSync(alwaysPath, JSON.stringify({ always: ["bash", "desk_state", "tasks"] }));
      const expected = ["bash", "canvas_read", "task_close", "task_comment", "task_create", "task_list"];
      expect(new Approvals({ alwaysPath }).always()).toEqual(expected);
      expect((JSON.parse(readFileSync(alwaysPath, "utf8")) as { always: string[] }).always.sort()).toEqual(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
