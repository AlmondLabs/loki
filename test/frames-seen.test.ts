import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeenStore } from "../mod/seen.ts";
import { seenChatFrame, seenFrame } from "../mod/frames/seen.ts";
import { bridgeWith, client } from "./fixtures/frames.ts";

describe("the seen push", () => {
  test("the turn-start mark pushes the same frame seen_list answers, focus included", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-seen-"));
    try {
      const seen = new SeenStore(join(dir, "attention.json"), { debounceMs: 0 });
      seen.mark("a", "c1");
      seen.engage("a", "c1", "message");
      const { bridge } = bridgeWith({ seen });
      const c = client("d1");
      bridge.onMessage(c, { type: "seen_list" });
      expect(seenFrame({ seen })).toEqual(c.sent.at(-1) as never);
      expect(Object.keys((c.sent.at(-1) as { focus: object }).focus)).toEqual(["a/c1"]);
      seen.flush();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a chat's own push says what the whole frame says of that chat, and null where it says nothing (plan 055)", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-seen-"));
    let clock = "2026-10-30T10:00:00.000Z";
    try {
      const seen = new SeenStore(join(dir, "attention.json"), { debounceMs: 0, now: () => clock });
      seen.mark("a", "done");
      seen.view("a", "done");
      seen.engage("a", "done", "answer");
      seen.rest("a", "rested", { n: 1, until: "2026-10-30T12:00:00.000Z", stamp: "s", at: clock });
      seen.mark("a", "undone");
      clock = "2026-10-30T10:01:00.000Z";
      seen.unmark("a", "undone");
      const whole = seenFrame({ seen });
      for (const conversation of ["done", "rested", "undone", "never"]) {
        const key = `a/${conversation}`;
        expect(seenChatFrame(seen, "a", conversation), key).toEqual({
          type: "seen_chat",
          key,
          seen: whole.seen[key] ?? null,
          viewed: whole.viewed?.[key] ?? null,
          focus: whole.focus?.[key] ?? null,
          rest: whole.rests?.[key] ?? null,
        });
      }
      expect(seenChatFrame(seen, "a", "undone").seen).toBeNull(); // a later "not done" undoes the done
      expect(seenChatFrame(seen, "a", "done").seen).toBe("2026-10-30T10:00:00.000Z");
      seen.flush();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a mark on one chat sends only that chat's marks to every client", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-seen-"));
    try {
      const seen = new SeenStore(join(dir, "attention.json"), { debounceMs: 0 });
      seen.mark("a", "other");
      const { bridge, broadcasts } = bridgeWith({ seen });
      const c = client("d1");
      bridge.onMessage(c, { type: "seen_mark", agent_id: "a", conversation_id: "c1" });
      bridge.onMessage(c, { type: "seen_unmark", agent_id: "a", conversation_id: "c1" });
      bridge.onMessage(c, {
        type: "card_rest",
        agent_id: "a",
        conversation_id: "c1",
        rest: { n: 0, until: "2026-10-30T12:00:00.000Z", stamp: "s", at: "2099-01-01T00:00:00.000Z" },
      });
      expect(broadcasts.map((b) => [b.frame.type, b.frame.key])).toEqual([
        ["seen_chat", "a/c1"],
        ["seen_chat", "a/c1"],
        ["seen_chat", "a/c1"],
      ]);
      expect(broadcasts[0]?.frame.seen).toEqual(expect.any(String));
      expect(broadcasts[1]?.frame.seen).toBeNull();
      expect(broadcasts[2]?.frame.rest).toMatchObject({ n: 0 });
      seen.flush();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
