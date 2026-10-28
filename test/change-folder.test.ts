import { describe, expect, test } from "vitest";
import { applyChatEvent, emptyLive, folderMoveAnswer, type ChatEvent } from "../core/attention/model.ts";
import { piece } from "./fixtures/chat-events.ts";
import { environmentReminder } from "../core/attention/content.ts";

/**
 * Change folder (useAttention changeFolder): the move is answered by a device event carrying the new folder, or an
 * error.
 */
describe("change folder", () => {
  test("a device status carries the conversation's live folder", () => {
    const l = emptyLive();
    expect(applyChatEvent(l, { kind: "device", cwd: "/work/a", mode: "default" }).changed).toBe(true);
    expect(l.cwd).toBe("/work/a");
    expect(applyChatEvent(l, { kind: "device", cwd: "/work/a", mode: "default" }).changed).toBe(false);
  });

  test("the move is answered by the new folder, refused by a loop error, and not by anything else", () => {
    const move = { from: "/work/a", to: "/work/b" };
    const status: ChatEvent[] = [{ kind: "device" }];
    expect(folderMoveAnswer(status, "/work/b", move)).toBe("moved");
    expect(folderMoveAnswer(status, "/private/work/b", move)).toBe("moved"); // the folder resolved (a symlink): still moved
    expect(folderMoveAnswer(status, "/work/a", move)).toBeNull(); // a status from before, or the change kept the old folder
    expect(folderMoveAnswer(status, "/work/other", { from: undefined, to: "/work/b" })).toBeNull(); // the old folder unknown: only the new one counts
    expect(folderMoveAnswer([{ kind: "error", message: "Not a directory: /work/b" }], "/work/a", move)).toEqual({
      error: "Not a directory: /work/b",
    });
    expect(folderMoveAnswer([{ kind: "step", step: piece("hi") }], "/work/a", move)).toBeNull();
  });

  test("the environment note leaves the folder out: it is the chat's working directory", () => {
    expect(environmentReminder({ desk: "x" })).not.toContain("working directory");
  });
});
