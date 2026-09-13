import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecallStore, newCardId } from "../mod/recall.ts";
import { isLearnTitle, learnTitle, type Card, type Lead } from "../core/recall/model.ts";

const T0 = new Date("2026-09-10T09:00:00Z").getTime();
const card = (id: string, over: Partial<Card> = {}): Card => ({
  id, front: `q ${id}`, back: `a ${id}`, tags: ["t"], createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(), updatedBy: "recall", previous: [],
  source: { agentId: "a", agentName: "ira", conversationId: "c", title: "main chat", at: null }, ...over,
});

let dir: string;
let store: RecallStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loki-recall-"));
  store = new RecallStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("recall store", () => {
  test("a fresh dir has no cards, no rejections and default worker settings", () => {
    expect(store.cards()).toEqual([]);
    expect(store.rejected()).toEqual([]);
    expect(store.status(T0)).toEqual({ enabled: false, model: null, dailyCap: 25, lastRunAt: null, lastRunNote: null, writtenToday: 0 });
  });
  test("add writes a card file and a fresh schedule; cards come back oldest first", () => {
    store.add(card("b", { createdAt: "2026-09-10T10:00:00Z" }));
    store.add(card("a", { createdAt: "2026-09-10T09:00:00Z" }));
    const rows = store.cards();
    expect(rows.map((r) => r.card.id)).toEqual(["a", "b"]);
    expect(rows[0].schedule.lastReview).toBeNull();
    expect(JSON.parse(readFileSync(join(dir, "cards", "a.json"), "utf8")).front).toBe("q a");
  });
  test("grade writes the schedule only; the card file is untouched", () => {
    store.add(card("a"));
    const before = readFileSync(join(dir, "cards", "a.json"), "utf8");
    const s = store.grade("a", 3, T0)!;
    expect(s.reps).toBe(1);
    expect(s.lastReview).toBe(new Date(T0).toISOString());
    expect(readFileSync(join(dir, "cards", "a.json"), "utf8")).toBe(before);
    expect(store.grade("nope", 3, T0)).toBeNull();
  });
  test("edit keeps the old wording in previous and marks who changed it; the schedule stays", () => {
    store.add(card("a"));
    store.grade("a", 3, T0);
    const c = store.edit("a", { back: "a better answer" }, "you", T0 + 1000)!;
    expect(c.back).toBe("a better answer");
    expect(c.updatedBy).toBe("you");
    expect(c.previous).toHaveLength(1);
    expect(c.previous[0].back).toBe("a a");
    expect(store.card("a")!.schedule.reps).toBe(1);
    // tags alone are not a wording change
    const t = store.edit("a", { tags: ["x"] }, "recall", T0 + 2000)!;
    expect(t.tags).toEqual(["x"]);
    expect(t.previous).toHaveLength(1);
    expect(t.updatedBy).toBe("you");
  });
  test("reject moves the card to the pile with its rep count; restore brings it back fresh; forget drops it", () => {
    store.add(card("a"));
    store.grade("a", 1, T0);
    store.grade("a", 1, T0 + 1);
    const rec = store.reject("a", T0 + 2)!;
    expect(rec.reps).toBe(2);
    expect(store.cards()).toEqual([]);
    expect(store.rejected().map((r) => r.card.id)).toEqual(["a"]);
    expect(store.restore("a")!.id).toBe("a");
    expect(store.rejected()).toEqual([]);
    expect(store.card("a")!.schedule.reps).toBe(0);
    store.reject("a", T0 + 3);
    store.forget("a");
    expect(store.rejected()).toEqual([]);
    expect(store.reject("nope")).toBeNull();
  });
  test("the worker's daily count rolls over with the day and settings merge over defaults", () => {
    store.noteWritten(3, T0);
    store.noteWritten(2, T0 + 60_000);
    expect(store.writtenToday(T0)).toBe(5);
    expect(store.writtenToday(T0 + 86_400_000)).toBe(0);
    store.saveWorker({ dailyCap: 4, model: "anthropic/claude-haiku-4-5", cursors: { "a/c": 12 } });
    const w = store.worker();
    expect(w.dailyCap).toBe(4);
    expect(w.enabled).toBe(false); // off until the user switches it on
    expect(w.cursors["a/c"]).toBe(12);
  });
  test("a corrupt card file is skipped, a card without a schedule file gets a fresh one", () => {
    store.add(card("a"));
    writeFileSync(join(dir, "cards", "bad.json"), "{not json");
    rmSync(join(dir, "schedule", "a.json"));
    const rows = store.cards();
    expect(rows).toHaveLength(1);
    expect(rows[0].schedule.due).toBe(new Date(T0).toISOString());
  });
  test("ids carry the day and are unique", () => {
    expect(newCardId(T0)).toMatch(/^20260910-[a-z0-9]{6}$/);
    expect(newCardId(T0)).not.toBe(newCardId(T0));
  });
});

describe("leads and lessons", () => {
  const lead = (id: string, title = `topic ${id}`): Lead => ({ id, title, why: "it went by", depth: "primer", source: { agentId: "a", agentName: "ira", conversationId: "c", title: "main chat", at: null }, createdAt: new Date(T0).toISOString() });
  test("a lead is added, dismissed to its pile, and restored", () => {
    store.addLead(lead("l1"));
    store.addLead(lead("l2"));
    expect(store.leads().map((l) => l.id).sort()).toEqual(["l1", "l2"]);
    expect(store.dismissLead("l1", T0)?.lead.title).toBe("topic l1");
    expect(store.leads().map((l) => l.id)).toEqual(["l2"]);
    expect(store.dismissedLeads()).toHaveLength(1);
    expect(store.dismissLead("nope")).toBeNull();
    expect(store.restoreLead("l1")?.id).toBe("l1");
    expect(store.dismissedLeads()).toEqual([]);
    expect(store.leads()).toHaveLength(2);
  });
  test("starting a lead records the lesson and takes the lead off the pile", () => {
    store.addLead(lead("l1"));
    const lesson = store.startLesson("l1", { agentId: "a", conversationId: "conv-9" }, T0);
    expect(lesson).toMatchObject({ agentId: "a", conversationId: "conv-9", lead: { id: "l1" } });
    expect(store.leads()).toEqual([]);
    expect(store.lessons()[0].conversationId).toBe("conv-9");
    expect(store.startLesson("l1", { agentId: "a", conversationId: "x" })).toBeNull();
  });
  test("Learn conversations are named by prefix and recognised by it", () => {
    expect(learnTitle("  Savings Plans ")).toBe("[Learn] · Savings Plans");
    expect(isLearnTitle("[Learn] · Savings Plans")).toBe(true);
    expect(isLearnTitle(" [Learn] · x")).toBe(true);
    expect(isLearnTitle("Learn about x")).toBe(false);
    expect(isLearnTitle(null)).toBe(false);
  });
});
