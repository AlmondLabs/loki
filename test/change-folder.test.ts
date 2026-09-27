import { describe, expect, test } from "bun:test";
import { AppServerSocket } from "../core/attention/protocol.ts";
import { applyEvent, emptyLive, folderMoveAnswer } from "../core/attention/model.ts";
import { environmentReminder } from "../core/attention/content.ts";
import type { Transport } from "../core/attention/transport.ts";

/**
 * Change folder (core/attention/protocol.ts changeFolder, useAttention changeFolder): Letta Code's
 * change_device_state with a cwd, answered by a device status carrying the new folder or a loop error.
 */
describe("change folder", () => {
  test("sends change_device_state for the conversation with the folder", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const transport: Transport = { open: (h) => queueMicrotask(h.onOpen), send: (raw) => void sent.push(JSON.parse(raw)), close() {} };
    const socket = new AppServerSocket("ws://test", () => transport);
    await socket.changeFolder({ agent_id: "a1", conversation_id: "c1" }, "/work/next");
    expect(sent.at(-1)).toEqual({ type: "change_device_state", runtime: { agent_id: "a1", conversation_id: "c1" }, payload: { cwd: "/work/next" } });
    socket.close();
  });

  test("a device status carries the conversation's live folder", () => {
    const l = emptyLive();
    expect(applyEvent(l, { type: "update_device_status", device_status: { current_working_directory: "/work/a", current_permission_mode: "default" } }).changed).toBe(true);
    expect(l.cwd).toBe("/work/a");
    expect(applyEvent(l, { type: "update_device_status", device_status: { current_working_directory: "/work/a", current_permission_mode: "default" } }).changed).toBe(false);
  });

  test("the move is answered by the new folder, refused by a loop error, and not by anything else", () => {
    const move = { from: "/work/a", to: "/work/b" };
    const status = { type: "update_device_status", device_status: {} };
    expect(folderMoveAnswer(status, "/work/b", move)).toBe("moved");
    expect(folderMoveAnswer(status, "/private/work/b", move)).toBe("moved"); // the folder resolved (a symlink): still moved
    expect(folderMoveAnswer(status, "/work/a", move)).toBeNull(); // a status from before, or the change kept the old folder
    expect(folderMoveAnswer(status, "/work/other", { from: undefined, to: "/work/b" })).toBeNull(); // the old folder unknown: only the new one counts
    expect(folderMoveAnswer({ type: "stream_delta", delta: { message_type: "loop_error", message: "Not a directory: /work/b" } }, "/work/a", move)).toEqual({ error: "Not a directory: /work/b" });
    expect(folderMoveAnswer({ type: "stream_delta", delta: { message_type: "assistant_message", content: "hi" } }, "/work/a", move)).toBeNull();
  });

  test("the environment note leaves the folder to Letta Code", () => {
    expect(environmentReminder({ desk: "x" })).not.toContain("working directory");
  });
});
