import { describe, expect, test } from "bun:test";
import { EMPTY_DRAFT, createDrafts, createFocusMemory, createRecents, createScrollMemory, draftKey, pushRecent, sanitizeRecents, type RecentEntry } from "../app/src/phone/session.ts";

/**
 * The phone's session layer (app/src/phone/session.ts): drafts keyed by conversation, bounded recent
 * histories on the device, scroll positions by destination, and the control a route was opened from.
 */

const img = (id: string) => ({ id, mediaType: "image/png", data: "", url: `blob:${id}` });

describe("drafts", () => {
  test("keys are per agent and conversation", () => {
    expect(draftKey("a1", "default")).not.toBe(draftKey("a2", "default"));
    expect(draftKey("a1", "c1")).not.toBe(draftKey("a1", "c2"));
    expect(draftKey("a1", "c1")).toBe(draftKey("a1", "c1"));
  });
  test("each key holds its own text and images", () => {
    const d = createDrafts();
    const k1 = draftKey("a1", "c1");
    const k2 = draftKey("a1", "c2");
    d.set(k1, { text: "one", images: [img("x")] });
    d.set(k2, { text: "two", images: [] });
    expect(d.get(k1)).toEqual({ text: "one", images: [img("x")] });
    expect(d.get(k2).text).toBe("two");
    expect(d.get(draftKey("a9", "c9"))).toEqual(EMPTY_DRAFT);
  });
  test("clearing the submitted conversation leaves the others", () => {
    const d = createDrafts();
    const k1 = draftKey("a1", "c1");
    const k2 = draftKey("a1", "c2");
    d.set(k1, { text: "one", images: [] });
    d.set(k2, { text: "two", images: [] });
    d.clear(k1);
    expect(d.get(k1)).toEqual(EMPTY_DRAFT);
    expect(d.get(k2).text).toBe("two");
  });
  test("an emptied draft is forgotten rather than kept as blank", () => {
    const d = createDrafts();
    const k = draftKey("a1", "c1");
    d.set(k, { text: "x", images: [] });
    d.set(k, { text: "", images: [] });
    expect(d.keys()).toEqual([]);
  });
  test("subscribers hear only their key", () => {
    const d = createDrafts();
    const k1 = draftKey("a1", "c1");
    const heard: string[] = [];
    const off = d.subscribe(k1, () => heard.push(d.get(k1).text));
    d.set(draftKey("a1", "c2"), { text: "other", images: [] });
    d.set(k1, { text: "mine", images: [] });
    d.clear(k1);
    off();
    d.set(k1, { text: "after", images: [] });
    expect(heard).toEqual(["mine", ""]);
  });
  test("the same draft object comes back until it changes (a stable snapshot for React)", () => {
    const d = createDrafts();
    const k = draftKey("a1", "c1");
    d.set(k, { text: "x", images: [] });
    expect(d.get(k)).toBe(d.get(k));
    expect(d.get("none")).toBe(d.get("none2"));
  });
});

/** A Storage stand-in: a map, or one that throws like a private window's. */
function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), raw: m };
}
const throwing = {
  getItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("denied");
  },
  removeItem: () => {
    throw new Error("denied");
  },
};

describe("recents", () => {
  const e = (v: string, at: number): RecentEntry => ({ v, at });
  test("a new entry goes first; a repeat moves up instead of doubling; the list is bounded", () => {
    let l: RecentEntry[] = [];
    for (const [v, at] of [["a", 1], ["b", 2], ["c", 3], ["a", 4]] as const) l = pushRecent(l, v, at, 3);
    expect(l.map((x) => x.v)).toEqual(["a", "c", "b"]);
    l = pushRecent(l, "d", 5, 3);
    expect(l.map((x) => x.v)).toEqual(["d", "a", "c"]);
  });
  test("blank entries are ignored and whitespace trimmed", () => {
    expect(pushRecent([], "   ", 1, 5)).toEqual([]);
    expect(pushRecent([], "  q  ", 1, 5)).toEqual([e("q", 1)]);
  });
  test("reading drops junk, stale entries, duplicates and whatever the caller no longer knows", () => {
    const now = 100_000;
    const raw = JSON.stringify([e("a", now - 10), { v: 3, at: 1 }, "x", e("gone", now - 5), e("a", now - 20), e("old", now - 99_000), e("b", now - 30)]);
    expect(sanitizeRecents(raw, { max: 5, maxAgeMs: 50_000, now, valid: (v) => v !== "gone" }).map((x) => x.v)).toEqual(["a", "b"]);
    expect(sanitizeRecents("not json", { max: 5, maxAgeMs: 50_000, now })).toEqual([]);
    expect(sanitizeRecents('{"v":"a"}', { max: 5, maxAgeMs: 50_000, now })).toEqual([]);
    expect(sanitizeRecents(null, { max: 5, maxAgeMs: 50_000, now })).toEqual([]);
  });
  test("reading caps an over-long stored list", () => {
    const raw = JSON.stringify(Array.from({ length: 30 }, (_, i) => e(`q${i}`, 1000 - i)));
    expect(sanitizeRecents(raw, { max: 8, maxAgeMs: 10_000, now: 1000 })).toHaveLength(8);
  });
  test("persists to storage and reads back", () => {
    const s = memoryStorage();
    let now = 1000;
    const r = createRecents({ storage: s, key: "k", max: 3, maxAgeMs: 10_000, now: () => now });
    r.add("first");
    now = 1001;
    r.add("second");
    expect(r.read()).toEqual(["second", "first"]);
    const again = createRecents({ storage: s, key: "k", max: 3, maxAgeMs: 10_000, now: () => now });
    expect(again.read((v) => v !== "first")).toEqual(["second"]);
    again.clear();
    expect(r.read()).toEqual([]);
  });
  test("a storage that throws or is missing reads as empty and never throws", () => {
    for (const storage of [throwing, null]) {
      const r = createRecents({ storage, key: "k", max: 3, maxAgeMs: 10_000 });
      expect(() => r.add("x")).not.toThrow();
      expect(r.read()).toEqual([]);
      expect(() => r.clear()).not.toThrow();
    }
  });
});

describe("scroll memory", () => {
  test("remembers the offset per destination", () => {
    const m = createScrollMemory();
    m.save("home", 420);
    m.save("agents", 80);
    expect(m.get("home")).toBe(420);
    expect(m.get("agents")).toBe(80);
    expect(m.get("more")).toBeNull();
  });
  test("a negative or fractional offset is stored sane", () => {
    const m = createScrollMemory();
    m.save("home", -30);
    expect(m.get("home")).toBe(0);
    m.save("home", 12.6);
    expect(m.get("home")).toBe(13);
  });
});

describe("focus return", () => {
  const el = (connected = true) => ({ isConnected: connected, id: "", getAttribute: () => null }) as unknown as Element;
  test("the launcher of a destination comes back once", () => {
    const f = createFocusMemory();
    const a = el();
    f.remember("#/home", a);
    expect(f.take("#/home")).toBe(a);
    expect(f.take("#/home")).toBeNull();
  });
  test("a launcher that left the page is not returned", () => {
    const f = createFocusMemory();
    f.remember("#/agents", el(false));
    expect(f.take("#/agents")).toBeNull();
  });
  test("each destination keeps its own", () => {
    const f = createFocusMemory();
    const a = el();
    const b = el();
    f.remember("#/home", a);
    f.remember("#/inbox", b);
    expect(f.take("#/inbox")).toBe(b);
    expect(f.take("#/home")).toBe(a);
  });
  test("nothing to remember is no entry", () => {
    const f = createFocusMemory();
    f.remember("#/home", null);
    expect(f.take("#/home")).toBeNull();
  });
});
