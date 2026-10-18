import { describe, expect, test } from "vitest";
import { PeerState, type PersonState } from "../mod/peer-state.ts";

const MINI = "bbbbbbbb-2222-4222-8222-222222222222";
const empty: PersonState = {
  marks: { seen: {}, unseen: {}, viewed: {}, focus: {}, skips: {} },
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
