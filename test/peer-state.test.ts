import { describe, expect, test, vi } from "vitest";
import { FRAMES, stateFolders } from "../core/frames.ts";
import { PeerState, type PersonState } from "../mod/peer-state.ts";

const MINI = "bbbbbbbb-2222-4222-8222-222222222222";
const empty: PersonState = {
  marks: { seen: {}, unseen: {}, viewed: {}, focus: {}, rests: {} },
  pins: {},
  labels: { colors: {}, changed: {} },
  learn: { files: {}, deleted: {} },
  mcp: { servers: {}, removed: {} },
  mods: { files: {}, deleted: {} },
};

describe("the person's state between Macs", () => {
  test("a pull takes the other Mac's state through its rules; out of reach, nothing happens", async () => {
    const applied: string[] = [];
    let up = true;
    const link = { request: () => (up ? Promise.resolve({ type: "peer_state", ...empty }) : Promise.reject(new Error("out of reach"))) };
    const state = new PeerState({
      snapshot: () => empty,
      apply: (id) => (applied.push(id), { marks: true, pins: false, labels: false, learn: false, mcp: false, mods: false }),
      link: () => link as never,
      tell: () => {},
    });
    expect(await state.pull(MINI)).toEqual({ marks: true, pins: false, labels: false, learn: false, mcp: false, mods: false });
    up = false;
    expect(await state.pull(MINI)).toBeNull();
    expect(applied).toEqual([MINI]);
  });

  test("a burst of changes here tells paired Macs once", async () => {
    let told = 0;
    const state = new PeerState({
      snapshot: () => empty,
      apply: () => ({ marks: false, pins: false, labels: false, learn: false, mcp: false, mods: false }),
      link: () => null,
      tell: () => told++,
      debounceMs: 5,
    });
    state.changed();
    state.changed();
    state.changed();
    await new Promise((r) => setTimeout(r, 30));
    expect(told).toBe(1);
  });
});

describe("Learn's and the mods' files travel only when they changed (plan 040)", () => {
  const none = { marks: false, pins: false, labels: false, learn: false, mcp: false, mods: false };

  test("a burst tells paired Macs the folders it changed, and none when only small parts did", () => {
    vi.useFakeTimers();
    try {
      const told: string[][] = [];
      const state = new PeerState({ snapshot: () => empty, apply: () => none, link: () => null, tell: (f) => told.push(f), debounceMs: 5 });
      state.changed();
      state.changed("learn");
      state.changed();
      vi.advanceTimersByTime(10);
      state.changed();
      vi.advanceTimersByTime(10);
      expect(told).toEqual([["learn"], []]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a pull asks for the folders named, or every one when none is given; the parts that came are applied", async () => {
    const asked: Array<Record<string, unknown>> = [];
    const applied: PersonState[] = [];
    const { learn: _learn, mods: _mods, ...small } = empty;
    const link = { request: (frame: Record<string, unknown>) => (asked.push(frame), Promise.resolve({ type: "peer_state", ...small })) };
    const state = new PeerState({ snapshot: () => empty, apply: (_, theirs) => (applied.push(theirs), none), link: () => link as never, tell: () => {} });
    await state.pull(MINI, []);
    await state.pull(MINI, ["learn"]);
    await state.pull(MINI);
    expect(asked).toEqual([{ type: "peer_state_get", folders: [] }, { type: "peer_state_get", folders: ["learn"] }, { type: "peer_state_get" }]);
    expect(applied.map((s) => [s.marks === small.marks, s.learn, s.mods])).toEqual([
      [true, undefined, undefined],
      [true, undefined, undefined],
      [true, undefined, undefined],
    ]);
  });

  test("a frame naming no folders, as an older loki's, means every one; unknown names are dropped", () => {
    expect(stateFolders(undefined)).toBeUndefined();
    expect(stateFolders([])).toEqual([]);
    expect(stateFolders(["mods", "nonsense", "learn"])).toEqual(["learn", "mods"]);
    expect(FRAMES.peer_state_get.parse({ type: "peer_state_get" })).toEqual({ folders: undefined });
    expect(FRAMES.peer_state_get.parse({ type: "peer_state_get", folders: ["learn"] })).toEqual({ folders: ["learn"] });
  });
});
