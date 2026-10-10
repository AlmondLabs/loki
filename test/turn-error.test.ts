import { describe, expect, test } from "vitest";
import { readTurnError, retryMessage } from "../app/src/chat/turnError.ts";

describe("a failed turn, in words", () => {
  test("Bun's dropped socket inside Letta's llm_error JSON reads as a dropped connection, the JSON kept", () => {
    const raw = '{ "error": { "error": { "type": "llm_error", "message": "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()", "detail": "…" }, "run_id": "local-run-442" } }';
    expect(readTurnError(raw)).toEqual({ text: "The connection to the model dropped partway through.", raw });
    expect(readTurnError("fetch failed").text).toBe("The connection to the model dropped partway through.");
  });
  test("anything else reads as its own message, on one line", () => {
    expect(readTurnError('{"error":{"message":"Rate limit reached for gpt-6"}}').text).toBe("Rate limit reached for gpt-6");
    expect(readTurnError("the turn failed")).toEqual({ text: "the turn failed", raw: null });
  });
});

describe("trying again", () => {
  test("a message the agent never answered is sent again; a turn cut off partway gets a nudge to continue", () => {
    expect(retryMessage([{ role: "assistant", text: "hi" }, { role: "user", text: "11 first" }])).toEqual({ label: "Send again", text: "11 first" });
    expect(retryMessage([{ role: "user", text: "11 first" }, { role: "tool", text: "Bash · ls" }, { role: "event", text: "skill loaded" }])?.label).toBe("Continue");
    expect(retryMessage([])).toBeNull();
  });
});
