import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPinChanges, isPinned, pinChanges, readPins, setPin } from "../mod/pins.ts";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "loki-pins-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("pins: Desktop's pinned-conversations.json", () => {
  test("reads Desktop's shape and answers per conversation", () => {
    const f = join(dir, "pins.json");
    writeFileSync(f, JSON.stringify({ version: 1, agents: { "agent-1": ["c1", "c2"], "agent-2": ["c9"] } }));
    expect([...readPins(f)].sort()).toEqual(["agent-1/c1", "agent-1/c2", "agent-2/c9"]);
    expect(isPinned("agent-1", "c2", f)).toBe(true);
    expect(isPinned("agent-1", "c3", f)).toBe(false);
    expect(isPinned(null, "c1", f)).toBe(false);
  });
  test("pin and unpin rewrite the file, keeping other agents and dropping empty lists", () => {
    const f = join(dir, "pins2.json");
    writeFileSync(f, JSON.stringify({ version: 1, agents: { "agent-2": ["c9"] } }));
    const at = () => "2026-10-18T10:00:00.000Z";
    expect(setPin("agent-1", "c1", true, f, at)).toBe(true);
    expect(setPin("agent-1", "c1", true, f, at)).toBe(true); // idempotent
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({
      version: 1,
      agents: { "agent-2": ["c9"], "agent-1": ["c1"] },
      changed: { "agent-1/c1": { pinned: true, at: "2026-10-18T10:00:00.000Z" } },
    });
    setPin("agent-1", "c1", false, f);
    expect((JSON.parse(readFileSync(f, "utf8")) as { agents: unknown }).agents).toEqual({ "agent-2": ["c9"] });
  });
  test("a missing file starts empty", () => {
    const f = join(dir, "nope", "pins.json");
    expect(readPins(f).size).toBe(0);
    setPin("agent-1", "c1", true, f);
    expect(isPinned("agent-1", "c1", f)).toBe(true);
  });

  test("between two Macs, a pin made on one appears on the other, and the later change wins either way", () => {
    const book = join(dir, "book-pins.json");
    const mini = join(dir, "mini-pins.json");
    writeFileSync(book, JSON.stringify({ version: 1, agents: { "agent-1": ["old"] } }));
    setPin("agent-1", "c1", true, book, () => "2026-10-18T10:00:00.000Z");
    // A pin from before pins had times reaches a Mac that has never seen it.
    expect(applyPinChanges(pinChanges(book), mini)).toBe(true);
    expect(readPins(mini)).toEqual(new Set(["agent-1/old", "agent-1/c1"]));
    // Unpinned on the mini later: it beats the MacBook's older pin, and not the other way round.
    setPin("agent-1", "c1", false, mini, () => "2026-10-18T11:00:00.000Z");
    expect(applyPinChanges(pinChanges(mini), book)).toBe(true);
    expect(isPinned("agent-1", "c1", book)).toBe(false);
    expect(applyPinChanges(pinChanges(book), mini)).toBe(false);
  });
});
