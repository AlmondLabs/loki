import { describe, expect, test } from "vitest";
import type { LanStatus } from "../core/frame-types.ts";
import type { PushFrame } from "../core/frames.ts";
import { EMPTY_DESK_SOCKET, STATE_PUSHES, applyPush, opened, type DeskSocketState } from "../app/src/workspace/workspace-pushes.ts";

const NOW = Date.parse("2026-10-30T10:00:00Z");
const ctx = { now: NOW, lastInteraction: 0 };
const fold = (pushes: PushFrame[], from: DeskSocketState = EMPTY_DESK_SOCKET, at = ctx) => pushes.reduce((s, p) => applyPush(s, p, at), from);

const lan = (enabled: boolean): { type: "lan_status" } & LanStatus => ({
  type: "lan_status",
  enabled,
  address: null,
  addresses: [],
  host: null,
  port: 41415,
  app_served: false,
  error: null,
  via: "lan",
  tailscale: null,
});

describe("what the mod's pushes leave in a tab (plan 058)", () => {
  test("chat_meta fills in the chat's header and agent id; the same push again changes nothing", () => {
    const title = {
      type: "chat_meta",
      scope: "c1",
      title: "plans",
      status: "live",
      agent_name: "Ada",
      agent_id: "ada",
      model: "m",
      reasoning_effort: "high",
      mode: "default",
    } as const;
    const s = fold([title]);
    expect(s).toMatchObject({ titles: { c1: "plans" }, agentIds: { c1: "ada" }, reasoningEfforts: { c1: "high" } });
    expect(applyPush(s, title, ctx)).toBe(s);
    expect(applyPush(s, { ...title, reasoning_effort: null }, ctx).reasoningEfforts).toEqual({});
  });

  test("the marks keep their maps when a push repeats them, and one chat's mark is set or cleared alone", () => {
    const seen = { type: "seen", seen: { "ada/c1": "t1" }, viewed: {}, focus: {}, rests: {} } as const;
    const s = fold([seen]);
    expect(applyPush(s, seen, ctx)).toBe(s);
    const cleared = applyPush(s, { type: "seen_chat", key: "ada/c1", seen: null, viewed: null, focus: null, rest: null }, ctx);
    expect(cleared.seenMap).toEqual({});
    expect(cleared.focusMap).toBe(s.focusMap);
  });

  test("lanes are null until a push carries them; a push without them keeps them (plan 087, U3)", () => {
    const seen = { type: "seen", seen: {}, viewed: {}, focus: {}, rests: {} } as const;
    expect(fold([seen]).lanes).toBeNull();
    const lanes = [{ id: "l-work", name: "Work", chats: "all" as const, accounts: [] }];
    const s = fold([{ ...seen, lanes }]);
    expect(s.lanes).toEqual(lanes);
    expect(applyPush(s, seen, ctx)).toBe(s);
    expect(applyPush(s, { ...seen, lanes: [] }, ctx).lanes).toEqual([]);
  });

  test("a pairing code lasts while the listener is up", () => {
    const s = fold([lan(true), { type: "pair_code", code: "123456", url: "http://mac.local:41415/pair", expires_at: "later" }]);
    expect(s.pairCode?.code).toBe("123456");
    expect(applyPush(s, lan(false), ctx).pairCode).toBeNull();
  });

  test("each restart due shows again, and a socket that opens owes none", () => {
    const s = fold([
      { type: "restart_due", file: "daemon/a.ts" },
      { type: "restart_due", file: "daemon/a.ts" },
    ]);
    expect(s.restartDue).toEqual({ file: "daemon/a.ts", n: 2 });
    expect(opened(s).restartDue).toBeNull();
    expect(opened(EMPTY_DESK_SOCKET)).toBe(EMPTY_DESK_SOCKET);
  });

  test("a chat's streamed events are not the state's, so they cost no update; an unknown push changes nothing", () => {
    expect(STATE_PUSHES.has("chat_event")).toBe(false);
    expect(STATE_PUSHES.has("lists_changed")).toBe(false);
    const s = fold([{ type: "models_recent", recent: ["a", "b"] }]);
    expect(applyPush(s, { type: "models_recent", recent: ["a", "b"] }, ctx)).toBe(s);
    expect(applyPush(s, { type: "lists_changed" }, ctx)).toBe(s);
  });
});
