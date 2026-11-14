import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { COMMIT_REST_MS, createListSelection, heldRows, listKeyOf, moveFor, stepRow, type Schedule } from "../app/src/shell/list-keys.ts";
import { ContentList, NothingSelected, onListKeyDown } from "../app/src/shell/content-list.tsx";

/**
 * One list's keyboard and selection, as Mail's (plan 2026-11-14-1330, KTD3): arrows highlight at once and commit after
 * 150 ms of rest, a click or Return commits at once, and an action on the highlighted row commits it first.
 */

const IDS = ["a", "b", "c"];
const key = (k: string, mods: Partial<{ alt: boolean; meta: boolean; ctrl: boolean; shift: boolean }> = {}) => ({
  key: k,
  altKey: !!mods.alt,
  metaKey: !!mods.meta,
  ctrlKey: !!mods.ctrl,
  shiftKey: !!mods.shift,
});

/** A clock the test moves by hand: `schedule` runs a job once `advance` passes its time, and cancelling drops it. */
function manualClock() {
  let now = 0;
  const jobs: Array<{ at: number; run: () => void; live: boolean }> = [];
  const schedule: Schedule = (run, ms) => {
    const job = { at: now + ms, run, live: true };
    jobs.push(job);
    return () => {
      job.live = false;
    };
  };
  const advance = (ms: number) => {
    now += ms;
    for (const job of jobs) {
      if (job.live && job.at <= now) {
        job.live = false;
        job.run();
      }
    }
  };
  return { schedule, advance };
}

/** A selection over IDS starting on `start`, recording what it commits and where it sends focus. */
function selection(start: string | null = "a") {
  const clock = manualClock();
  const log: string[] = [];
  let committed = start;
  const sel = createListSelection({
    committed: () => committed,
    commit: (id) => {
      committed = id;
      log.push(`commit ${id}`);
    },
    focusDetail: (id) => log.push(`detail ${id}`),
    onHighlight: () => {},
    schedule: clock.schedule,
  });
  /** A selection made elsewhere (⌘K, a notification, landing): the place's committed row changes without the list. */
  const selectElsewhere = (id: string) => {
    committed = id;
  };
  return { sel, clock, log, committed: () => committed, selectElsewhere };
}

describe("the keys a list takes", () => {
  test("↑ ↓ Return and Tab, bare; with a modifier they are the keymap's, and ⇧Tab moves focus back", () => {
    expect([key("ArrowUp"), key("ArrowDown"), key("Enter"), key("Tab")].map(listKeyOf)).toEqual(["up", "down", "enter", "tab"]);
    expect(listKeyOf(key("ArrowDown", { meta: true }))).toBeNull();
    expect(listKeyOf(key("ArrowDown", { alt: true }))).toBeNull();
    expect(listKeyOf(key("Tab", { shift: true }))).toBeNull();
    expect(listKeyOf(key("e"))).toBeNull();
  });
  test("↓ on the last row stays put, and ↑ on the first stays put", () => {
    expect(moveFor(IDS, "c", "down")).toEqual({ highlight: "c", commit: null, focusDetail: false });
    expect(moveFor(IDS, "a", "up")).toEqual({ highlight: "a", commit: null, focusDetail: false });
    expect(moveFor(IDS, "a", "down")).toEqual({ highlight: "b", commit: "rest", focusDetail: false });
  });
  test("with nothing selected ↓ takes the first row and ↑ the last", () => {
    expect(moveFor(IDS, null, "down").highlight).toBe("a");
    expect(moveFor(IDS, null, "up").highlight).toBe("c");
    expect(moveFor([], null, "down")).toEqual({ highlight: null, commit: null, focusDetail: false });
  });
  test("Return and Tab commit at once and ask for the detail", () => {
    expect(moveFor(IDS, "b", "enter")).toEqual({ highlight: "b", commit: "now", focusDetail: true });
    expect(moveFor(IDS, "b", "tab")).toEqual({ highlight: "b", commit: "now", focusDetail: true });
  });
});

describe("a selection over time", () => {
  test("three ↓ in 100 ms commit once, 150 ms after the last", () => {
    const { sel, clock, log } = selection("a");
    sel.press(["a", "b", "c", "d"], "down");
    clock.advance(50);
    sel.press(["a", "b", "c", "d"], "down");
    clock.advance(50);
    sel.press(["a", "b", "c", "d"], "down");
    expect(sel.pending()).toBe("d");
    clock.advance(COMMIT_REST_MS - 1);
    expect(log).toEqual([]);
    clock.advance(1);
    expect(log).toEqual(["commit d"]);
    expect(sel.pending()).toBeNull();
  });
  test("Return on a highlighted row commits at once and asks for focus in the detail", () => {
    const { sel, clock, log } = selection("a");
    sel.press(IDS, "down");
    sel.press(IDS, "enter");
    expect(log).toEqual(["commit b", "detail b"]);
    clock.advance(COMMIT_REST_MS);
    expect(log).toEqual(["commit b", "detail b"]);
  });
  test("Return on the committed row only asks for the detail", () => {
    const { sel, log } = selection("b");
    sel.press(IDS, "enter");
    expect(log).toEqual(["detail b"]);
  });
  test("an action on a highlighted row within the 150 ms commits that row first, then acts on it", () => {
    const { sel, clock, log } = selection("a");
    sel.press(IDS, "down");
    clock.advance(100);
    sel.act((id) => log.push(`archive ${id}`));
    expect(log).toEqual(["commit b", "archive b"]);
    clock.advance(COMMIT_REST_MS);
    expect(log).toEqual(["commit b", "archive b"]);
  });
  test("an action with nothing pending acts on the committed row, and on none with nothing selected", () => {
    const { sel, log } = selection("c");
    sel.act((id) => log.push(`archive ${id}`));
    expect(log).toEqual(["archive c"]);
    const none = selection(null);
    none.sel.act((id) => none.log.push(`archive ${id}`));
    expect(none.log).toEqual([]);
  });
  test("a click commits at once and drops a pending highlight; a click on the committed row commits nothing", () => {
    const { sel, clock, log } = selection("a");
    sel.press(IDS, "down");
    sel.click("c");
    clock.advance(COMMIT_REST_MS);
    expect(log).toEqual(["commit c"]);
    sel.click("c");
    expect(log).toEqual(["commit c"]);
  });
  test("a row selected elsewhere during the rest drops the pending highlight, so the timer does not commit over it", () => {
    const { sel, clock, log, committed, selectElsewhere } = selection("a");
    sel.press(IDS, "down");
    selectElsewhere("c");
    clock.advance(COMMIT_REST_MS);
    expect(log).toEqual([]);
    expect(committed()).toBe("c");
    expect(sel.pending()).toBeNull();
    // the arrows then move from the row selected elsewhere
    sel.press(IDS, "up");
    expect(sel.pending()).toBe("b");
  });
  test("an action after a row was selected elsewhere acts on that row, not the stale highlight", () => {
    const { sel, log, selectElsewhere } = selection("a");
    sel.press(IDS, "down");
    selectElsewhere("c");
    sel.act((id) => log.push(`archive ${id}`));
    expect(log).toEqual(["archive c"]);
  });
  test("the row the person sees: the pending highlight, else the committed one", () => {
    const { sel } = selection("a");
    expect(sel.current()).toBe("a");
    sel.press(IDS, "down");
    expect(sel.current()).toBe("b");
  });
  test("arrowing back to the committed row before the rest commits nothing", () => {
    const { sel, clock, log } = selection("a");
    sel.press(IDS, "down");
    sel.press(IDS, "up");
    clock.advance(COMMIT_REST_MS);
    expect(log).toEqual([]);
  });
});

describe("⌘[ and ⌘] step the rows the list draws (R16)", () => {
  test("⌘] goes to the next row, round from either end; with no row selected, the first or the last", () => {
    expect(stepRow(IDS, "a", 1)).toBe("b");
    expect(stepRow(IDS, "c", 1)).toBe("a");
    expect(stepRow(IDS, "a", -1)).toBe("c");
    expect(stepRow(IDS, null, 1)).toBe("a");
    expect(stepRow(IDS, "gone", -1)).toBe("c");
    expect(stepRow([], null, 1)).toBeNull();
  });
  test("⌘] during an arrow's rest steps from the highlighted row and commits once, the timer committing nothing after", () => {
    const { sel, clock, log } = selection("a");
    sel.press(IDS, "down");
    sel.step(IDS, 1);
    expect(log).toEqual(["commit c"]);
    clock.advance(COMMIT_REST_MS);
    expect(log).toEqual(["commit c"]);
  });
  test("⌘] from a selected row held after it left the source goes to its neighbour, not the top", () => {
    const row = (id: string) => ({ id });
    // c is archived while selected: the source's rows lose it, the list still draws it in place
    const held = heldRows(["a", "b", "d"].map(row), ["a", "b", "c", "d"].map(row), "c").map((r) => r.id);
    expect(held).toEqual(["a", "b", "c", "d"]);
    const { sel, log } = selection("c");
    sel.step(held, 1);
    expect(log).toEqual(["commit d"]);
  });
});

describe("rows that change under the selection", () => {
  const row = (id: string) => ({ id });
  test("rows replaced while one is selected keep the selection by id", () => {
    const { sel, committed } = selection("b");
    const fresh = ["x", "b", "y"];
    expect(heldRows(fresh.map(row), IDS.map(row), "b").map((r) => r.id)).toEqual(fresh);
    sel.press(fresh, "down");
    expect(sel.pending()).toBe("y");
    expect(committed()).toBe("b");
  });
  test("a selected row that leaves the rows stays where it was until the selection moves", () => {
    const before = IDS.map(row);
    const after = [row("a"), row("c")];
    const held = heldRows(after, before, "b");
    expect(held.map((r) => r.id)).toEqual(["a", "b", "c"]);
    // the next render keeps it while it is still selected, and drops it once the selection moves on
    expect(heldRows(after, held, "b").map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(heldRows(after, held, "c").map((r) => r.id)).toEqual(["a", "c"]);
  });
  test("a Search hides the selected row like any other, so a Search with no match is empty", () => {
    expect(heldRows([], IDS.map(row), "b", true)).toEqual([]);
  });
});

describe("the list element's keys", () => {
  /** A keydown on a row: whether it was stopped, and whether a window listener (bubbling after the list) would see it. */
  const press = (k: string, mods: Parameters<typeof key>[1] = {}, start: string | null = "a") => {
    let stopped = false;
    let prevented = false;
    const e = {
      ...key(k, mods),
      stopPropagation: () => {
        stopped = true;
      },
      preventDefault: () => {
        prevented = true;
      },
    };
    const { sel } = selection(start);
    onListKeyDown(e, IDS, sel, () => {});
    return { reachesWindow: !stopped, prevented };
  };
  test("a key the list handles (↓, Return) does not reach a window keydown listener", () => {
    expect(press("ArrowDown")).toEqual({ reachesWindow: false, prevented: true });
    expect(press("Enter")).toEqual({ reachesWindow: false, prevented: true });
    expect(press("ArrowUp").reachesWindow).toBe(false); // even staying put on the first row, so Learn's ↑ never sees it
  });
  test("with nothing selected, Return and Tab are left to the row and the browser, so Tab leaves the list", () => {
    expect(press("Tab", {}, null)).toEqual({ reachesWindow: true, prevented: false });
    expect(press("Enter", {}, null)).toEqual({ reachesWindow: true, prevented: false });
    expect(press("Tab")).toEqual({ reachesWindow: false, prevented: true });
    expect(press("ArrowDown", {}, null)).toEqual({ reachesWindow: false, prevented: true });
  });
  test("a key the list leaves alone (E, ⌘↓) goes on to the window", () => {
    expect(press("e")).toEqual({ reachesWindow: true, prevented: false });
    expect(press("ArrowDown", { meta: true })).toEqual({ reachesWindow: true, prevented: false });
  });
});

describe("the list's markup", () => {
  const html = (props: Partial<Parameters<typeof ContentList>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(ContentList, {
        label: "Friday",
        title: "Friday",
        rows: [
          { id: "a", title: "Budget" },
          { id: "b", title: "Launch" },
        ],
        selectedId: "b",
        onSelect: () => {},
        onEnter: () => {},
        empty: "No chats with friday yet.",
        ...props,
      }),
    );
  test("rows stay <li><button aria-current>, the selected one the only tab stop", () => {
    const out = html();
    expect(out).toMatch(/<li class="loki-list-item" data-current="true"><button type="button" class="loki-list-row" aria-current="page" tabindex="0"/);
    expect(out.match(/tabindex="0"/g)?.length).toBe(1);
    expect(out.match(/class="loki-list-row"[^>]*tabindex="-1"/g)?.length).toBe(1);
  });
  test("with nothing selected the first row holds the tab stop", () => {
    expect(html({ selectedId: null })).toMatch(/data-row="a" tabindex="0"|tabindex="0" data-row="a"/);
  });
  test("the list is a section named for its source, its toolbar the title and a grey count", () => {
    const out = html({ count: 2 });
    expect(out).toMatch(/^<section class="loki-content-list" aria-label="Friday">/);
    expect(out).toContain('<h2 class="loki-content-list-title">Friday</h2>');
    expect(out).toContain('<span class="loki-content-list-count">2</span>');
  });
  test("an empty source shows its sentence and the place's New", () => {
    const out = html({ rows: [], newAction: { label: "New Chat", run: () => {} } });
    expect(out).toContain("No chats with friday yet.");
    expect(out).toContain(">New Chat</button>");
  });
  test("an empty Search shows No Results", () => {
    const out = html({ rows: [], query: "zebra", onQuery: () => {} });
    expect(out).toContain("No Results");
    expect(out).not.toContain("No chats with friday yet.");
  });
  test("an empty list puts the place's New under its sentence, unless the place keeps it to the toolbar", () => {
    const newAction = { label: "New Agent", run: () => {} };
    const under = (out: string) => out.split('class="loki-content-list-empty"')[1] ?? "";
    expect(under(html({ rows: [], newAction }))).toContain(">New Agent</button>");
    const kept = html({ rows: [], newAction, emptyAction: false });
    expect(under(kept)).not.toContain("New Agent");
    expect(kept).toContain('aria-label="New Agent"');
  });
  test("nothing selected shows the detail's No … Selected pane", () => {
    expect(renderToStaticMarkup(createElement(NothingSelected, { noun: "Chat" }))).toContain("No Chat Selected");
  });
});
