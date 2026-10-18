import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyShared, homeOf, later, merge, readRecord, readTombstones, sharedAgents, stamp } from "../daemon/store/agent-sync.ts";
import { writeRecord } from "../daemon/store/agents.ts";

const BOOK = "aaaaaaaa-1111-4111-8111-111111111111";
const MINI = "bbbbbbbb-2222-4222-8222-222222222222";
const FRIDAY = "agent-local-11111111-1111-4111-8111-111111111111";

/** A backend folder holding one agent record with its memory folder, as the daemon lays them out. */
function backend(records: Record<string, Record<string, unknown>> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "loki-agent-sync-"));
  for (const [id, record] of Object.entries(records)) {
    mkdirSync(join(dir, "memfs", id, "memory"), { recursive: true });
    writeRecord(dir, id, record);
  }
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("which change is later", () => {
  test("by time, then by Mac id, so both Macs agree", () => {
    expect(later({ at: "2026-10-18T10:00:00Z", mac: BOOK }, { at: "2026-10-18T10:01:00Z", mac: BOOK })).toBe(true);
    expect(later({ at: "2026-10-18T10:01:00Z", mac: BOOK }, { at: "2026-10-18T10:00:00Z", mac: MINI })).toBe(false);
    expect(later({ at: "2026-10-18T10:00:00Z", mac: BOOK }, { at: "2026-10-18T10:00:00Z", mac: MINI })).toBe(true);
    expect(later({ at: "2026-10-18T10:00:00Z", mac: MINI }, { at: "2026-10-18T10:00:00Z", mac: BOOK })).toBe(false);
    expect(later({ at: "", mac: "" }, { at: "", mac: BOOK })).toBe(true);
  });
});

describe("one agent's record across two Macs", () => {
  test("a rename on one Mac and a model change on the other, made apart, both survive", () => {
    const base = { id: FRIDAY, name: "Friday", model: "openai/gpt-6.1-sol" };
    const onBook = stamp({ ...base, name: "Friday (work)" }, ["name"], { at: "2026-10-18T10:00:00Z", mac: BOOK });
    const onMini = stamp({ ...base, model: "anthropic/claude-opus-5-5" }, ["model"], { at: "2026-10-18T10:05:00Z", mac: MINI });
    const book = merge(onBook, onMini);
    const mini = merge(onMini, onBook);
    expect(book).toMatchObject({ name: "Friday (work)", model: "anthropic/claude-opus-5-5" });
    expect(mini).toMatchObject({ name: "Friday (work)", model: "anthropic/claude-opus-5-5" });
  });

  test("two changes to one field keep the later, and an older one changes nothing", () => {
    const early = stamp({ id: FRIDAY, name: "A" }, ["name"], { at: "2026-10-18T10:00:00Z", mac: MINI });
    const late = stamp({ id: FRIDAY, name: "B" }, ["name"], { at: "2026-10-18T11:00:00Z", mac: BOOK });
    expect(merge(early, late)?.name).toBe("B");
    expect(merge(late, early)).toBeNull();
  });

  test("a record with no home lives on the Mac that has it, and goes out saying so", () => {
    const b = backend({ [FRIDAY]: { id: FRIDAY, name: "Friday" } });
    try {
      expect(homeOf(readRecord(b.dir, FRIDAY), BOOK)).toBe(BOOK);
      const [shared] = sharedAgents(b.dir, BOOK);
      expect(shared.record).toMatchObject({ home_mac: BOOK, changed: { home_mac: { at: "", mac: BOOK } } });
      // A home set later anywhere wins over that unstamped one.
      expect(merge(shared.record, stamp({ id: FRIDAY, home_mac: MINI }, ["home_mac"], { at: "2026-10-18T10:00:00Z", mac: MINI }))?.home_mac).toBe(MINI);
    } finally {
      b.done();
    }
  });

  test("Letta's helper agents are not shared", () => {
    const b = backend({ [FRIDAY]: { id: FRIDAY, name: "Letta Code", tags: ["role:subagent"] } });
    try {
      expect(sharedAgents(b.dir, BOOK)).toEqual([]);
    } finally {
      b.done();
    }
  });
});

describe("taking another Mac's agents", () => {
  test("a Mac with no agents writes every record it is sent, ids and homes as they were", async () => {
    const book = backend({ [FRIDAY]: { id: FRIDAY, name: "Friday", model: "m" } });
    const mini = backend();
    try {
      const applied = await applyShared(mini.dir, { agents: sharedAgents(book.dir, BOOK), tombstones: [] }, () => Promise.resolve());
      expect(applied).toEqual({ created: [FRIDAY], updated: [], deleted: [] });
      expect(readRecord(mini.dir, FRIDAY)).toMatchObject({ id: FRIDAY, name: "Friday", model: "m", home_mac: BOOK });
      // Sent again, nothing changes.
      expect(await applyShared(mini.dir, { agents: sharedAgents(book.dir, BOOK), tombstones: [] }, () => Promise.resolve())).toEqual({
        created: [],
        updated: [],
        deleted: [],
      });
    } finally {
      book.done();
      mini.done();
    }
  });

  test("an agent deleted on one Mac is deleted on the other, and a later rename from there does not bring it back", async () => {
    const mini = backend({ [FRIDAY]: { id: FRIDAY, name: "Friday" } });
    const removed: string[] = [];
    try {
      const del = (id: string) => (removed.push(id), Promise.resolve());
      const applied = await applyShared(mini.dir, { agents: [], tombstones: [{ id: FRIDAY, at: "2026-10-18T10:00:00Z", mac: BOOK }] }, del);
      expect(applied.deleted).toEqual([FRIDAY]);
      expect(removed).toEqual([FRIDAY]);
      expect(readTombstones(mini.dir).map((t) => t.id)).toEqual([FRIDAY]);
      const rename = stamp({ id: FRIDAY, name: "Friday 2" }, ["name"], { at: "2026-10-18T11:00:00Z", mac: MINI });
      expect((await applyShared(mini.dir, { agents: [{ id: FRIDAY, record: rename }], tombstones: [] }, del)).created).toEqual([]);
    } finally {
      mini.done();
    }
  });
});
