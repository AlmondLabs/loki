import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPinned, readPins, setPin } from "../mod/pins.ts";

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
    expect(setPin("agent-1", "c1", true, f)).toBe(true);
    expect(setPin("agent-1", "c1", true, f)).toBe(true); // idempotent
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ version: 1, agents: { "agent-2": ["c9"], "agent-1": ["c1"] } });
    setPin("agent-1", "c1", false, f);
    expect(JSON.parse(readFileSync(f, "utf8")).agents).toEqual({ "agent-2": ["c9"] });
  });
  test("a missing file starts empty", () => {
    const f = join(dir, "nope", "pins.json");
    expect(readPins(f).size).toBe(0);
    setPin("agent-1", "c1", true, f);
    expect(isPinned("agent-1", "c1", f)).toBe(true);
  });
});
