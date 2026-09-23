import { describe, expect, test } from "bun:test";
import { buildSearchIndex, cleanQuery, groupHits, rankHits, tierOf, type Indexed } from "../app/src/shared/search.ts";

/**
 * The shared search core (app/src/shared/search.ts): matching and ranking over any hit type, with no
 * routes and no pages of its own. The phone (phone/searchIndex.ts) and the desktop's ⌘K each build their
 * hits and destinations on top of it.
 */

/** A hit that is only a name and a group: nothing a router knows about. */
type Thing = { id: string; group: "a" | "b" };
const entry = (id: string, fields: string[], recency = 0, group: Thing["group"] = "a"): Indexed<Thing> => ({ hit: { id, group }, fields, recency });
const ids = (hits: Thing[]) => hits.map((h) => h.id);

describe("shared search core", () => {
  test("ranks exact, prefix, word start and substring matches in that order", () => {
    const idx = buildSearchIndex([entry("substring", ["automobile"]), entry("word", ["loki mobile"]), entry("prefix", ["mobile budget"]), entry("exact", ["Mobile"]), entry("none", ["banana"])]);
    expect(ids(rankHits(idx, "mobile"))).toEqual(["exact", "prefix", "word", "substring"]);
  });
  test("a title beats a secondary field at the same tier; any field's better tier wins", () => {
    const idx = buildSearchIndex([entry("second", ["zeta", "ledgers"]), entry("title", ["ledger"]), entry("better", ["the ledger", "ledger"])]);
    expect(ids(rankHits(idx, "ledger"))).toEqual(["title", "better", "second"]);
  });
  test("ties break newest first, then by the order given", () => {
    const idx = buildSearchIndex([entry("old", ["note"], 1), entry("first", ["note"]), entry("new", ["note"], 9), entry("second", ["note"])]);
    expect(ids(rankHits(idx, "note"))).toEqual(["new", "old", "first", "second"]);
  });
  test("folds case, accents and whitespace; a blank query is nothing", () => {
    const idx = buildSearchIndex([entry("cafe", ["Café  Notes"])]);
    expect(ids(rankHits(idx, "  cafe notes "))).toEqual(["cafe"]);
    expect(rankHits(idx, "   ")).toEqual([]);
    expect(tierOf("Loki mobile", "MOBILE")).toBe(2);
    expect(cleanQuery("  two   words ")).toBe("two words");
  });
  test("regex characters are text", () => {
    const idx = buildSearchIndex([entry("dot", ["a.b"]), entry("any", ["axb"])]);
    expect(ids(rankHits(idx, "a.b"))).toEqual(["dot"]);
  });
  test("groups keep a fixed order, drop empty ones, cap their hits and count them all", () => {
    const idx = buildSearchIndex([entry("b1", ["x"], 0, "b"), entry("a1", ["x"]), entry("a2", ["x"]), entry("a3", ["x"])]);
    const groups = groupHits(rankHits(idx, "x"), (h) => h.group, ["a", "b"], { a: "As", b: "Bs" }, 2);
    expect(groups.map((g) => [g.id, g.title, g.total, ids(g.hits)])).toEqual([
      ["a", "As", 3, ["a1", "a2"]],
      ["b", "Bs", 1, ["b1"]],
    ]);
    expect(groupHits([], (h: Thing) => h.group, ["a", "b"], { a: "As", b: "Bs" }, 2)).toEqual([]);
  });
  test("the index folds a copy: the entries handed in are left as they were", () => {
    const raw = [entry("x", ["Café"])];
    buildSearchIndex(raw);
    expect(raw[0].fields).toEqual(["Café"]);
  });
});
