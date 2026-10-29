import { describe, expect, test } from "vitest";
import type { CardWithSchedule } from "../core/recall/model.ts";
import { returned } from "../app/src/recall/use-deck-pass.ts";
import { must } from "./fixtures/must.ts";

/** Only a card's id matters to which cards came back. */
const deck = (...ids: string[]): CardWithSchedule[] => ids.map((id) => ({ card: { id } }) as never);

describe("a sitting with the deck", () => {
  test("a card deleted this sitting and brought back (undo, restore) is in the queue again; an answered one is not", () => {
    // a answered, b deleted: b leaves the deck, and is noted as away.
    const left = must(returned(new Set(["a", "b"]), new Set(), deck("a", "c")), "a change");
    expect([...left.passed]).toEqual(["a", "b"]);
    expect([...left.away]).toEqual(["b"]);
    expect(returned(left.passed, left.away, deck("a", "c"))).toBeNull();
    // b restored: it is passed no more.
    const back = must(returned(left.passed, left.away, deck("a", "b", "c")), "a change");
    expect([...back.passed]).toEqual(["a"]);
    expect([...back.away]).toEqual([]);
    expect(returned(back.passed, back.away, deck("a", "b", "c"))).toBeNull();
  });
});
