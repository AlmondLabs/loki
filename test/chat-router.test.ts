import { describe, expect, test } from "vitest";
import { ChatRouter, scopeOfFrame } from "../mod/chat-router.ts";

const MINI = "bbbbbbbb-2222-4222-8222-222222222222";
const THIRD = "cccccccc-3333-4333-8333-333333333333";

/** A router where conv-1 (scope conv-1) lives on the mini, and everything else here. */
const router = () =>
  new ChatRouter({
    homeOf: (c) => (c === "conv-1" ? { mac: MINI, reachable: true } : null),
    homeOfScope: (s) => (s === "conv-1" ? { mac: MINI, reachable: true } : null),
    link: () => null,
    name: () => "Mac mini",
    uploadsDir: "/nowhere",
    upload: () => Promise.resolve(null),
  });

describe("which frames go to another Mac", () => {
  test("a chat frame naming its chat, and a canvas frame naming its desk or widget, go to the Mac they live on", () => {
    const r = router();
    expect(r.target({ type: "chat_send", conversation_id: "conv-1", agent_id: "a" })).toEqual({ mac: MINI, reachable: true });
    expect(r.target({ type: "chat_send", conversation_id: "conv-2" })).toBeNull();
    expect(r.target({ type: "gesture", gesture: { id: "conv-1/w", kind: "focus" } })).toEqual({ mac: MINI, reachable: true });
    expect(r.target({ type: "desk_get", scope: "conv-1" })).toEqual({ mac: MINI, reachable: true });
    expect(r.target({ type: "seen_mark", conversation_id: "conv-1" })).toBeNull();
  });

  test("the desk a canvas frame names", () => {
    expect(scopeOfFrame({ scope: "d1" })).toBe("d1");
    expect(scopeOfFrame({ id: "d1/w" })).toBe("d1");
    expect(scopeOfFrame({ gesture: { id: "d2/chart" } })).toBe("d2");
    expect(scopeOfFrame({ id: "no-slash" })).toBeNull();
  });

  test("an unreachable home is not asked: the client hears that the chat waits for it", async () => {
    expect(await router().forward({ mac: MINI, reachable: false }, { type: "chat_send" }, "request")).toEqual({
      ok: false,
      message: "waiting for Mac mini: this chat lives there",
    });
  });
});

describe("which pushes from another Mac are passed on here", () => {
  test("only those about its own chats and desks, so three Macs never echo each other", () => {
    const r = router();
    expect(r.relay(MINI, { type: "chat_event", conversation_id: "conv-1", agent_id: "a", events: [] })).toEqual({});
    expect(r.relay(THIRD, { type: "chat_event", conversation_id: "conv-1", events: [] })).toBe(false);
    expect(r.relay(MINI, { type: "chat_event", conversation_id: "conv-2", events: [] })).toBe(false);
    expect(r.relay(MINI, { type: "state", scope: "conv-1", state: {} })).toEqual({ scope: "conv-1" });
    expect(r.relay(MINI, { type: "peers" })).toBe(false);
  });
});
