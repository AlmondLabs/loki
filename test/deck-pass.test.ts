import { describe, expect, test, vi } from "vitest";
import { newSchedule } from "../core/recall/fsrs.ts";
import type { CardWithSchedule } from "../core/recall/model.ts";
import { returned, useDeckPass } from "../app/src/recall/use-deck-pass.ts";
import { must } from "./fixtures/must.ts";

/**
 * The hooks the deck pass uses, run without a renderer: each `useState` is a slot kept across renders in call order, and
 * `useMemo` recomputes every render. Enough to drive the hook through a sitting by hand.
 */
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], at: 0 }));
vi.mock("react", () => ({
  useState: (init: unknown) => {
    const k = hooks.at++;
    if (!(k in hooks.slots)) hooks.slots[k] = typeof init === "function" ? (init as () => unknown)() : init;
    const set = (v: unknown) => {
      hooks.slots[k] = typeof v === "function" ? (v as (p: unknown) => unknown)(hooks.slots[k]) : v;
    };
    return [hooks.slots[k], set];
  },
  useMemo: (fn: () => unknown) => fn(),
}));

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

/** Due cards, oldest first, so the queue is a, b, c. */
const due = ["a", "b", "c"].map((id, i): CardWithSchedule => ({
  card: { id, created_at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() } as never,
  schedule: newSchedule(Date.UTC(2026, 0, 1)),
}));
/** The sitting over `due`. */
const useSitting = () => useDeckPass(due);
/** One render of a hook, reading the slots the last render left. */
const renderOnce = <T>(hook: () => T): T => {
  hooks.at = 0;
  return hook();
};
/** One render of the sitting. */
const render = () => renderOnce(useSitting);

describe("choosing a card in Review's list", () => {
  test("a card chosen again after another shows its front, not the answer revealed before", () => {
    hooks.slots = [];
    render().reveal();
    expect(render().revealed).toBe(true);
    render().choose("b");
    expect(render().current?.card.id).toBe("b");
    render().choose("a");
    const back = render();
    expect(back.current?.card.id).toBe("a");
    expect(back.revealed).toBe(false);
  });
});

describe("passing a card by id (X on a row the list highlights)", () => {
  test("the card named leaves the queue, not the one that was under your hands", () => {
    hooks.slots = [];
    expect(render().current?.card.id).toBe("a");
    render().advance("b");
    const after = render();
    expect(after.queue.map((c) => c.card.id)).toEqual(["a", "c"]);
    expect(after.current?.card.id).toBe("a");
  });
});
