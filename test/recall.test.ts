import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { RecallStore, newCardId } from "../mod/recall.ts";
import { isLearnTitle, learnTitle, type Card, type Lead, type RecallSnapshot } from "../core/recall/model.ts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { newSchedule } from "../core/recall/fsrs.ts";
import { learnViews, parseLearnView, stepLearnView } from "../app/src/recall/views.ts";
import { learnSources } from "../app/src/recall/learn-column.tsx";
import { cardRows, deletedRows, holdDeckKeys, leadRows, reviewRows } from "../app/src/recall/learn-list.ts";
import { CardDetail } from "../app/src/recall/recall-parts.tsx";
import { nextInDeck } from "../app/src/recall/use-deck-pass.ts";
import { ContentList } from "../app/src/shell/content-list.tsx";
import { resolve } from "../app/src/shell/keymap.ts";
import { must } from "./fixtures/must.ts";

const T0 = new Date("2026-09-10T09:00:00Z").getTime();
const card = (id: string, over: Partial<Card> = {}): Card => ({
  id,
  front: `q ${id}`,
  back: `a ${id}`,
  tags: ["t"],
  created_at: new Date(T0).toISOString(),
  updated_at: new Date(T0).toISOString(),
  updated_by: "recall",
  previous: [],
  source: { agent_id: "a", agent_name: "ira", conversation_id: "c", title: "main chat", at: null },
  ...over,
});

let dir: string;
let store: RecallStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loki-recall-"));
  store = new RecallStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("recall store", () => {
  test("a fresh dir has no cards and no rejections", () => {
    expect(store.cards()).toEqual([]);
    expect(store.rejected()).toEqual([]);
  });
  test("an id that is not one never becomes a path: nothing outside the folder is written or removed", () => {
    const outside = join(dir, "..", `${basename(dir)}-victim.json`); // basename: Windows paths use backslashes
    writeFileSync(outside, "{}");
    try {
      for (const id of ["../x", "a/b", "..", ""]) {
        expect(() => store.add(card(id))).toThrow("not a card or lead id");
        expect(() => store.forget(id)).toThrow("not a card or lead id");
        expect(() => store.reject(id)).toThrow("not a card or lead id");
      }
      expect(() => store.forget(`../${basename(outside, ".json")}`)).toThrow();
      expect(readFileSync(outside, "utf8")).toBe("{}");
      // A rejection whose card carries a bad id (a file planted by hand) is not restored.
      mkdirSync(join(dir, "rejected"), { recursive: true });
      writeFileSync(join(dir, "rejected", "r1.json"), JSON.stringify({ card: card("../../evil"), at: new Date(T0).toISOString() }));
      expect(store.restore("r1")).toBeNull();
      // A card file with a bad id inside is left out of the list rather than breaking it.
      mkdirSync(join(dir, "cards"), { recursive: true });
      writeFileSync(join(dir, "cards", "odd.json"), JSON.stringify(card("../odd")));
      expect(store.cards()).toEqual([]);
    } finally {
      rmSync(outside, { force: true });
    }
  });
  test("add writes a card file and a fresh schedule; cards come back oldest first", () => {
    store.add(card("b", { created_at: "2026-09-10T10:00:00Z" }));
    store.add(card("a", { created_at: "2026-09-10T09:00:00Z" }));
    const rows = store.cards();
    expect(rows.map((r) => r.card.id)).toEqual(["a", "b"]);
    expect(rows[0].schedule.last_review).toBeNull();
    expect((JSON.parse(readFileSync(join(dir, "cards", "a.json"), "utf8")) as { front: unknown }).front).toBe("q a");
  });
  test("grade writes the schedule only; the card file is untouched", () => {
    store.add(card("a"));
    const before = readFileSync(join(dir, "cards", "a.json"), "utf8");
    const s = must(store.grade("a", 3, T0), "the schedule");
    expect(s.reps).toBe(1);
    expect(s.last_review).toBe(new Date(T0).toISOString());
    expect(readFileSync(join(dir, "cards", "a.json"), "utf8")).toBe(before);
    expect(store.grade("nope", 3, T0)).toBeNull();
  });
  test("edit keeps the old wording in previous and marks who changed it; the schedule stays", () => {
    store.add(card("a"));
    store.grade("a", 3, T0);
    const c = must(store.edit("a", { back: "a better answer" }, "you", T0 + 1000), "the edited card");
    expect(c.back).toBe("a better answer");
    expect(c.updated_by).toBe("you");
    expect(c.previous).toHaveLength(1);
    expect(c.previous[0].back).toBe("a a");
    expect(must(store.card("a"), "card a").schedule.reps).toBe(1);
    // tags alone are not a wording change
    const t = must(store.edit("a", { tags: ["x"] }, "recall", T0 + 2000), "the edited card");
    expect(t.tags).toEqual(["x"]);
    expect(t.previous).toHaveLength(1);
    expect(t.updated_by).toBe("you");
  });
  test("reject moves the card to the pile with its rep count; restore brings it back fresh; forget drops it", () => {
    store.add(card("a"));
    store.grade("a", 1, T0);
    store.grade("a", 1, T0 + 1);
    const rec = must(store.reject("a", T0 + 2), "the rejected record");
    expect(rec.reps).toBe(2);
    expect(store.cards()).toEqual([]);
    expect(store.rejected().map((r) => r.card.id)).toEqual(["a"]);
    expect(must(store.restore("a"), "the restored card").id).toBe("a");
    expect(store.rejected()).toEqual([]);
    expect(must(store.card("a"), "card a").schedule.reps).toBe(0);
    store.reject("a", T0 + 3);
    store.forget("a");
    expect(store.rejected()).toEqual([]);
    expect(store.reject("nope")).toBeNull();
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
  const lead = (id: string, title = `topic ${id}`): Lead => ({
    id,
    title,
    why: "it went by",
    depth: "primer",
    source: { agent_id: "a", agent_name: "ira", conversation_id: "c", title: "main chat", at: null },
    created_at: new Date(T0).toISOString(),
  });
  test("a lead is added, dismissed to its pile, and restored", () => {
    store.addLead(lead("l1"));
    store.addLead(lead("l2"));
    expect(
      store
        .leads()
        .map((l) => l.id)
        .sort(),
    ).toEqual(["l1", "l2"]);
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
    expect(lesson).toMatchObject({ agent_id: "a", conversation_id: "conv-9", lead: { id: "l1" } });
    expect(store.leads()).toEqual([]);
    expect(store.lessons()[0].conversation_id).toBe("conv-9");
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

describe("learn: the views as the sidebar's sources", () => {
  const snap = (over: Partial<RecallSnapshot> = {}): RecallSnapshot => ({
    cards: [],
    rejected: [],
    leads: [],
    dismissed_leads: [],
    lessons: [],
    worker: { enabled: true, daily_cap: 20, last_run_at: null, last_run_note: null, written_today: 0 },
    ...over,
  });

  test("the four views in order, each with what it shows: due cards, leads, every card, and the deleted cards and leads", () => {
    const rows = learnViews(
      snap({
        cards: [{}, {}, {}] as RecallSnapshot["cards"],
        leads: [{}] as RecallSnapshot["leads"],
        rejected: [{}] as RecallSnapshot["rejected"],
        dismissed_leads: [{}, {}] as RecallSnapshot["dismissed_leads"],
      }),
      2,
    );
    expect(rows.map((r) => [r.view, r.label, r.count])).toEqual([
      ["review", "Review", 2],
      ["leads", "Leads", 1],
      ["all", "All Cards", 3],
      ["deleted", "Deleted", 3],
    ]);
  });

  test("before the snapshot there are no counts", () => {
    expect(learnViews(null, 0).map((r) => r.count)).toEqual([0, 0, 0, 0]);
  });

  test("⌘[ and ⌘] step round the four", () => {
    expect(stepLearnView("review", 1)).toBe("leads");
    expect(stepLearnView("deleted", 1)).toBe("review");
    expect(stepLearnView("review", -1)).toBe("deleted");
  });

  test("a stored view reads back, anything else is review", () => {
    expect(parseLearnView("deleted")).toBe("deleted");
    expect(parseLearnView("cards")).toBe("review");
    expect(parseLearnView(null)).toBe("review");
  });
});

/** A card with its fresh schedule, as the snapshot carries it; `due` moves it out of the queue. */
const scheduled = (id: string, over: Partial<Card> = {}, due?: string): RecallSnapshot["cards"][number] => {
  const schedule = newSchedule(T0);
  return { card: card(id, over), schedule: due ? { ...schedule, due } : schedule };
};
const lead = (id: string): Lead => ({
  id,
  title: `lead ${id}`,
  why: `why ${id}`,
  depth: "primer",
  source: card(id).source,
  created_at: new Date(T0).toISOString(),
});

describe("learn on the list (plan 2026-11-14-1330, R14)", () => {
  test("the views are Learn's sources in the sidebar, Review with its due count; choosing one shows that view", () => {
    const chosen: string[] = [];
    const sources = learnSources({ snap: null, due: 4, view: "all", onView: (v) => chosen.push(v) });
    expect(sources.items.map((s) => [s.id, s.title, s.count])).toEqual([
      ["review", "Review", 4],
      ["leads", "Leads", 0],
      ["all", "All Cards", 0],
      ["deleted", "Deleted", 0],
    ]);
    expect(sources.selected).toBe("all");
    sources.onSelect("deleted");
    sources.onSelect(sources.all); // Learn's own row keeps the view showing
    expect(chosen).toEqual(["deleted"]);
  });

  /** A keydown on an element with focus: a row button in the list, or the detail's own element. */
  const keydown = (key: string, tagName: string, mods: { meta?: boolean } = {}, stop = () => {}) =>
    ({ key, metaKey: !!mods.meta, ctrlKey: false, shiftKey: false, altKey: false, target: { tagName }, stopPropagation: stop }) as unknown as KeyboardEvent;
  /** A keydown in the Review list's column: whether the window's keymap (bubbling after it) would still see it, and what it would do. */
  const inList = (key: string, mods: { meta?: boolean } = {}) => {
    let stopped = false;
    const e = keydown(key, "BUTTON", mods, () => (stopped = true));
    holdDeckKeys(e);
    return { reachesWindow: !stopped, binding: resolve(e, "learn")?.id ?? null };
  };
  test("with the detail focused, ↓ reveals and → grades, as before: the keys go to Learn's keymap", () => {
    expect(resolve(keydown("ArrowDown", "DIV"), "learn")?.id).toBe("recall.reveal");
    expect(resolve(keydown("ArrowRight", "DIV"), "learn")?.id).toBe("recall.good");
  });
  test("with the list focused, the deck's answers stay in the list: → and ← do not grade, space does not reveal", () => {
    for (const key of ["ArrowRight", "ArrowLeft", " ", "1", "2", "ArrowDown", "Enter"]) expect(inList(key).reachesWindow, key).toBe(false);
    // the rest act on the card as before, and ⌘] still steps the views
    expect(inList("x")).toEqual({ reachesWindow: true, binding: "recall.delete" });
    expect(inList("]", { meta: true })).toEqual({ reachesWindow: true, binding: "learn.nextView" });
  });

  test("the Review list mirrors the due queue; choosing a row makes it the next card, and the rest keep their order", () => {
    const queue = ["a", "b", "c", "d"].map((id) => scheduled(id));
    expect(reviewRows(queue, T0).map((r) => r.title)).toEqual(["q a", "q b", "q c", "q d"]);
    // c chosen: it is the card now; after it come a, b and d, in the queue's order
    const order: string[] = ["c"];
    let left = queue.filter((c) => c.card.id !== "c");
    let current = nextInDeck(queue, must(queue[2], "c"), true);
    while (current) {
      order.push(current.card.id);
      const at = current;
      current = nextInDeck(left, at, false);
      left = left.filter((c) => c !== at);
    }
    expect(order).toEqual(["c", "a", "b", "d"]);
    // with no choice, the card after the current one is next, as before
    expect(nextInDeck(queue, queue[0], false)?.card.id).toBe("b");
  });

  test("All Cards' Search filters the rows; a card chosen opens its editor in the detail", () => {
    const cards = [
      scheduled("a", { front: "What is FSRS?", updated_at: "2026-09-10T09:00:00Z" }),
      scheduled("b", { front: "Savings plans", tags: ["aws"], updated_at: "2026-09-11T09:00:00Z" }),
    ];
    expect(cardRows(cards, "", T0).map((r) => r.id)).toEqual(["b", "a"]); // newest edit first
    expect(cardRows(cards, "fsrs", T0).map((r) => r.id)).toEqual(["a"]);
    expect(cardRows(cards, "AWS", T0).map((r) => r.id)).toEqual(["b"]);
    const out = renderToStaticMarkup(createElement(CardDetail, { c: cards[0], onSave: () => {}, onDelete: () => {} }));
    expect(out).toContain('aria-label="Front"');
    expect(out).toContain("What is FSRS?</textarea>");
    expect(out).toContain(">Delete</button>");
  });

  test("Leads lists the open leads, then the lessons under way in a section of their own", () => {
    const lesson = { lead: lead("l2"), agent_id: "a", conversation_id: "c9", started_at: new Date(T0).toISOString(), empty: true };
    const rows = leadRows([lead("l1")], [lesson], T0);
    expect(rows.map((r) => [r.id, r.title, r.section])).toEqual([
      ["lead:l1", "lead l1", undefined],
      ["lesson:c9", "lead l2", "Lessons Under Way"],
    ]);
  });

  test("Deleted shows the rejected cards and the dismissed leads as two sections", () => {
    const rejected = [{ card: card("r1"), at: new Date(T0).toISOString(), reps: 0 }];
    const dismissed = [{ lead: lead("l1"), at: new Date(T0).toISOString() }];
    const rows = deletedRows(rejected, dismissed, T0);
    expect(rows.map((r) => [r.id, r.section])).toEqual([
      ["card:r1", "Deleted Cards"],
      ["lead:l1", "Dismissed Leads"],
    ]);
    const out = renderToStaticMarkup(
      createElement(ContentList, {
        label: "Deleted",
        title: "Deleted",
        rows,
        selectedId: null,
        onSelect: () => {},
        onEnter: () => {},
        empty: "Nothing deleted.",
      }),
    );
    expect(out).toContain("Deleted Cards");
    expect(out).toContain("Dismissed Leads");
  });
});
