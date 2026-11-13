import { describe, expect, test } from "vitest";
import { firstMessageStep, type FirstMessage } from "../app/src/desk/use-first-message.ts";

// Plan 2026-11-12-1505, U20: a chat made by its first message. Opening the chat renews the link, so the message waits
// for the new chat's link rather than going out on the one about to close.

const waiting: FirstMessage = { scope: "ada/new", runtime: { agent_id: "ada", conversation_id: "new" }, text: "hello", images: [], left: false };

describe("a new chat's first message", () => {
  test("waits while the pane is still on the chat before it, whatever the link says", () => {
    expect(firstMessageStep(waiting, "ada/old", "open")).toBe(waiting);
    expect(firstMessageStep(waiting, "ada/old", "closed")).toBe(waiting);
  });

  test("does not go on the old chat's link, still open when the pane has just switched", () => {
    expect(firstMessageStep(waiting, "ada/new", "open")).toBe(waiting);
  });

  test("notes the link going down, then goes when the new chat's link is open", () => {
    const left = firstMessageStep(waiting, "ada/new", "connecting");
    expect(left).toEqual({ ...waiting, left: true });
    if (left === "send") throw new Error("sent before the link opened");
    expect(firstMessageStep(left, "ada/new", "connecting")).toBe(left);
    expect(firstMessageStep(left, "ada/new", "open")).toBe("send");
  });
});
