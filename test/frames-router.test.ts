import { describe, expect, test } from "bun:test";
import { createBridge } from "../mod/bridge.ts";
import { fail, reply, type FrameHandlers } from "../mod/frames/context.ts";
import { DeskStore } from "../mod/desk-store.ts";
import { GestureLog } from "../mod/gestures.ts";
import { bridgeWith, client, fakeWidgets, settled } from "./fixtures/frames.ts";

describe("the frame router", () => {
  test("a request's reply goes out under the table's name, with its requestId", () => {
    const folders: FrameHandlers = { folder_complete: ({ prefix }) => reply({ matches: prefix ? [`${prefix}/src`] : [] }) };
    const { bridge } = bridgeWith({ modules: [folders] });
    const c = client("d1");
    bridge.onMessage(c, { type: "folder_complete", requestId: "r1", prefix: "/code" });
    expect(c.sent.at(-1)).toEqual({ type: "folder_matches", requestId: "r1", matches: ["/code/src"] });
  });

  test("every way a request can fail answers error with its requestId: refused, malformed, failed, thrown, rejected", async () => {
    const history: FrameHandlers = {
      history_get: ({ conversationId }) => (conversationId === "gone" ? fail("no such chat") : conversationId === "boom" ? (() => { throw new Error("disk on fire"); })() : reply({ agentId: null, conversationId, messages: [], more: false, widgetLog: [] })),
      folder_pick: async () => {
        throw new Error("the picker crashed");
      },
      task_create: () => reply({ task: { id: "t", title: "", description: "", status: "open", priority: 2, labels: [], assignee: null, createdAt: "", updatedAt: "", closedAt: null, metadata: {} } }),
    };
    const { bridge } = bridgeWith({ modules: [history] });
    const c = client("d1");
    bridge.onMessage(c, { type: "history_get", requestId: "r1" });
    expect(c.sent.at(-1)).toEqual({ type: "error", requestId: "r1", message: "conversationId required" });
    bridge.onMessage(c, { type: "history_get", requestId: "r2", conversationId: "gone" });
    expect(c.sent.at(-1)).toEqual({ type: "error", requestId: "r2", message: "no such chat" });
    bridge.onMessage(c, { type: "history_get", requestId: "r3", conversationId: "boom" });
    expect(c.sent.at(-1)).toEqual({ type: "error", requestId: "r3", message: "disk on fire" });
    bridge.onMessage(c, { type: "folder_pick", requestId: "r4" });
    await settled();
    expect(c.sent.at(-1)).toEqual({ type: "error", requestId: "r4", message: "the picker crashed" });
    const phone = client("d1", "dev-1");
    bridge.onMessage(phone, { type: "task_create", requestId: "r5", title: "x" });
    expect(phone.sent.at(-1)).toEqual({ type: "error", requestId: "r5", message: "task_create is not available on the phone" });
  });

  test("a send that is malformed, or whose handler fails, answers an error push without a requestId", () => {
    const lan: FrameHandlers = { lan_via_set: () => { throw new Error("the listener is closing"); } };
    const { bridge } = bridgeWith({ modules: [lan] });
    const c = client("d1");
    bridge.onMessage(c, { type: "lan_via_set", via: "bluetooth" });
    expect(c.sent.at(-1)).toEqual({ type: "error", message: 'via must be "tailscale" or "lan"' });
    bridge.onMessage(c, { type: "lan_via_set", via: "lan" });
    expect(c.sent.at(-1)).toEqual({ type: "error", message: "the listener is closing" });
  });

  test("a frame two modules answer is refused when the bridge is built", () => {
    const a: FrameHandlers = { seen_list: () => {} };
    const b: FrameHandlers = { seen_list: () => {} };
    expect(() => createBridge({ store: new DeskStore(), widgets: fakeWidgets([]), gestures: new GestureLog(), broadcast: () => {}, modules: [a, b] })).toThrow("two handlers for seen_list");
  });
});
