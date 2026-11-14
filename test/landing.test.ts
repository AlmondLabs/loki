import { describe, expect, test } from "vitest";
import type { DeskSummary } from "../core/frame-types.ts";
import { landing, landingKey } from "../app/src/shell/landing.ts";

// Plan 2026-11-14-1300, 1: a window with no chat lands somewhere real, as Mail opens on the Inbox, never an empty room.

const desk = (scope: string, lastActive: string | null, status: DeskSummary["status"] = "live") =>
  ({
    scope,
    last_active: lastActive,
    status,
    conversation_id: scope,
    title: scope,
    agent_name: "ira",
    agent_id: "ira",
    model: null,
    reasoning_effort: null,
    pinned: false,
    widgets: 0,
    active: false,
  }) as DeskSummary;
const base = { scope: "shared", onChats: true, ready: true, desks: [desk("a", "2026-11-13T10:00:00Z"), desk("b", "2026-11-14T09:00:00Z")], waiting: 0 };

describe("where a window lands", () => {
  test("Flow when something waits on the person", () => {
    expect(landing({ ...base, waiting: 3 })).toEqual({ kind: "flow" });
  });
  test("else the chat they were in most recently; an archived one never", () => {
    expect(landing(base)).toEqual({ kind: "chat", scope: "b" });
    expect(landing({ ...base, desks: [desk("a", "2026-11-13T10:00:00Z"), desk("z", "2026-11-14T12:00:00Z", "archived")] })).toEqual({
      kind: "chat",
      scope: "a",
    });
  });
  test("with neither, nothing: the pane says No Chat Selected", () => {
    expect(landing({ ...base, desks: [] })).toEqual({ kind: "none" });
  });
  test("nothing to decide until the chats and cards have come, or once a chat or another section shows", () => {
    expect(landing({ ...base, ready: false })).toBeNull();
    expect(landing({ ...base, scope: "conv-1" })).toBeNull();
    expect(landing({ ...base, onChats: false })).toBeNull();
  });
  test("a landing compares as one string", () => {
    expect([landingKey({ kind: "flow" }), landingKey({ kind: "none" }), landingKey({ kind: "chat", scope: "b" })]).toEqual(["flow", "none", "chat:b"]);
  });
});
