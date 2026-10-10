import { applyEvent, lettaChatEvents } from "./fixtures/letta-events.ts";
import { describe, expect, test } from "bun:test";
import { emptyLive, folderMoveAnswer as answerOf } from "../core/attention/model.ts";
import type { ServerEvent } from "../core/attention/protocol.ts";

/** The answer a Letta event gives, read through loki's chat events. */
const folderMoveAnswer = (ev: ServerEvent, cwd: string | undefined, move: { from: string | undefined; to: string }) => answerOf(lettaChatEvents(ev, "2026-10-10T00:00:00.000Z"), cwd, move);
import { environmentReminder } from "../core/attention/content.ts";

/**
 * Change folder (useAttention changeFolder): the move is answered by a device event carrying the new folder, or an
 * error (events written in Letta's shapes, test/fixtures/letta-events.ts).
 */
describe("change folder", () => {
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
