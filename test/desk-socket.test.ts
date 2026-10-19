import { describe, expect, test } from "vitest";
import { keepSame, macsFromFrame, withScope } from "../app/src/desk/use-desk-socket.ts";

/**
 * The mod repeats itself: every mark broadcasts the whole seen frame, and the desk list and titles come again
 * unchanged. A frame that says what the state already holds keeps the objects it has, so nothing re-renders on it.
 */
describe("desk socket: an identical frame keeps its references", () => {
  const seenFrame = () => ({
    seen: { "a/c1": "2026-09-25T10:00:00Z", "a/c2": "2026-09-24T09:00:00Z" },
    viewed: { "a/c1": "2026-09-25T10:01:00Z" },
    focus: { "a/c3": { w: 1.5, t: "2026-09-25T10:00:00Z" } },
  });

  test("the seen, viewed and focus maps stay the same objects when a seen frame repeats them", () => {
    const held = seenFrame();
    const again = seenFrame(); // fresh objects off the wire, the same content
    expect(keepSame(held.seen, again.seen)).toBe(held.seen);
    expect(keepSame(held.viewed, again.viewed)).toBe(held.viewed);
    expect(keepSame(held.focus, again.focus)).toBe(held.focus);
  });

  test("a change anywhere takes the new object", () => {
    const held = seenFrame();
    const moved = { ...seenFrame().viewed, "a/c1": "2026-09-25T10:05:00Z" };
    expect(keepSame(held.viewed, moved)).toBe(moved);
    const added = { ...seenFrame().seen, "a/c9": "2026-09-25T10:05:00Z" };
    expect(keepSame(held.seen, added)).toBe(added);
    const deeper = { "a/c3": { ...seenFrame().focus["a/c3"], w: 2 } };
    expect(keepSame(held.focus, deeper)).toBe(deeper);
    const fewer = { "a/c1": "2026-09-25T10:00:00Z" };
    expect(keepSame(held.seen, fewer)).toBe(fewer);
  });

  test("a repeated desks list keeps the list; a changed row replaces it", () => {
    const row = (title: string) => ({ scope: "c1", title, status: "live", agentName: "ira", pinned: true, widgets: 1, lastActive: "2026-09-25T10:00:00Z" });
    const held = [row("Revenue review"), row("Budget")];
    expect(keepSame(held, [row("Revenue review"), row("Budget")])).toBe(held);
    const renamed = [row("Revenue review"), row("Budget plan")];
    expect(keepSame(held, renamed)).toBe(renamed);
  });

  test("a repeated desk_title keeps each per-desk map", () => {
    const titles = { c1: "Revenue review", c2: "Budget" };
    expect(withScope(titles, "c1", "Revenue review")).toBe(titles);
    expect(withScope(titles, "c1", "Revenue")).toEqual({ c1: "Revenue", c2: "Budget" });
    expect(withScope(titles, "c3", "New")).toEqual({ c1: "Revenue review", c2: "Budget", c3: "New" });
  });
});

describe("desk socket: the Macs push", () => {
  test("keeps the computers on the tailnet beside this Mac and the paired ones", () => {
    const me = { mac_id: "m1", name: "MacBook", host: "macbook.tail1234.ts.net:41415" };
    const tailnet = [{ name: "Mac mini", address: "mac-mini.tail1234.ts.net", os: "macOS", online: true, paired: false }];
    expect(macsFromFrame({ me, peers: [], tailnet })).toEqual({ me, peers: [], tailnet });
    expect(macsFromFrame({ me, peers: [] })).toEqual({ me, peers: [], tailnet: [] });
  });
});
