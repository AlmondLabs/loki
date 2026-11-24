import { describe, expect, test } from "vitest";
import type { TranscriptRow } from "../core/attention/transcript.ts";
import { isNewSend } from "../app/src/chat/use-transcript-scroll.ts";
import { drawnRows, keepsFollowing, lastShown, newSince, nextAbove, REST_MS, restTimer, revealFrom } from "../app/src/item/thread-follow.ts";
import { CHUNK } from "../app/src/chat/transcript-window.ts";

const viewport = (awayFromBottom: boolean) =>
  ({ getAttribute: (name: string) => (name === "data-scrollable" ? (awayFromBottom ? "start end" : "start") : null) }) as unknown as HTMLElement;

const user = (text: string, queued = false): TranscriptRow => ({ role: "user", text, ...(queued ? { queued } : {}) });
const reply = (text: string): TranscriptRow => ({ role: "assistant", text });

describe("the desktop thread keeps following when a scroll at the bottom goes nowhere", () => {
  test("at the bottom, a wheel down or sideways keeps following", () => {
    expect(keepsFollowing(viewport(false), { deltaY: 40 })).toBe(true);
    expect(keepsFollowing(viewport(false), { deltaY: 0 })).toBe(true);
  });

  test("at the bottom, a wheel up leaves it, as the reader asked", () => {
    expect(keepsFollowing(viewport(false), { deltaY: -40 })).toBe(false);
  });

  test("at the bottom, the keys that scroll down keep following and the ones that scroll up do not", () => {
    for (const key of ["ArrowDown", "End", "PageDown", " "]) expect(keepsFollowing(viewport(false), { key, shiftKey: false })).toBe(true);
    for (const key of ["ArrowUp", "Home", "PageUp"]) expect(keepsFollowing(viewport(false), { key, shiftKey: false })).toBe(false);
    expect(keepsFollowing(viewport(false), { key: " ", shiftKey: true })).toBe(false);
  });

  test("a key that does not scroll asks for nothing", () => {
    expect(keepsFollowing(viewport(false), { key: "a", shiftKey: false })).toBe(false);
  });

  test("scrolled up, nothing is pulled back to the bottom", () => {
    expect(keepsFollowing(viewport(true), { deltaY: 40 })).toBe(false);
    expect(keepsFollowing(viewport(true), { key: "End", shiftKey: false })).toBe(false);
  });
});

describe("a queued message waits in the composer, not in the thread", () => {
  test("the row a send is followed by is the last one drawn, not a queued one after it", () => {
    const drawn = reply("working on it");
    expect(lastShown([user("go"), drawn, user("and this", true)])).toBe(drawn);
    expect(lastShown([user("and this", true)])).toBeNull();
  });

  test("the jump button counts the messages drawn since you left, not the queued ones", () => {
    const rows = [user("go"), reply("one"), { role: "tool", text: "read" } as TranscriptRow, reply("two"), user("later", true)];
    expect(newSince(drawnRows(rows), 1)).toBe(2);
  });

  test("a message queued while a reply streams goes in before that reply and adds nothing to the count", () => {
    const left = drawnRows([user("go"), reply("streaming…")]).length;
    const now = drawnRows([user("go"), user("and this", true), reply("streaming… more")]);
    expect(newSince(now, left)).toBe(0);
  });

  test("with nothing queued the rows are drawn as they are, the same list", () => {
    const rows = [user("go"), reply("one")];
    expect(drawnRows(rows)).toBe(rows);
  });
});

describe("only a new message of yours re-pins the thread", () => {
  test("your new row re-pins", () => {
    expect(isNewSend(reply("done"), user("thanks"))).toBe(true);
  });

  test("the same last row again (an older page arriving, the status changing) does not", () => {
    const mine = user("still there?");
    expect(isNewSend(mine, mine)).toBe(false);
  });

  test("the agent's row, or the thread's first load, does not", () => {
    expect(isNewSend(user("go"), reply("on it"))).toBe(false);
    expect(isNewSend(null, user("go"))).toBe(false);
  });
});

describe("older rows load until five screens are loaded above the reader", () => {
  const rowsAbove = { hiddenAbove: true, olderToAsk: false };

  test("inside five screens of the top of what is loaded, the next rows mount; beyond it, nothing", () => {
    expect(nextAbove({ scrollTop: 3000, clientHeight: 700 }, rowsAbove)).toBe("reveal");
    expect(nextAbove({ scrollTop: 3600, clientHeight: 700 }, rowsAbove)).toBe("far");
  });

  test("in a short window the distance is never less than 800px", () => {
    expect(nextAbove({ scrollTop: 600, clientHeight: 100 }, rowsAbove)).toBe("reveal");
  });

  test("with every row drawn, the daemon is asked for an older page from the same distance, once per length", () => {
    expect(nextAbove({ scrollTop: 3600, clientHeight: 700 }, { hiddenAbove: false, olderToAsk: true })).toBe("far");
    expect(nextAbove({ scrollTop: 3000, clientHeight: 700 }, { hiddenAbove: false, olderToAsk: true })).toBe("older");
    expect(nextAbove({ scrollTop: 3000, clientHeight: 700 }, { hiddenAbove: false, olderToAsk: false })).toBeNull();
  });

  test("a hidden pane counts as far from the top, so nothing is mounted or asked for", () => {
    expect(nextAbove({ scrollTop: 0, clientHeight: 0 }, rowsAbove)).toBe("far");
  });
});

describe("the thread is still once nothing has moved it for a moment", () => {
  function clock() {
    const due = new Map<number, { run: () => void; at: number }>();
    let now = 0;
    let ids = 0;
    return {
      scheduler: {
        set: (run: () => void, ms: number) => {
          due.set(++ids, { run, at: now + ms });
          return ids;
        },
        clear: (id: number) => void due.delete(id),
      },
      pass: (ms: number) => {
        now += ms;
        for (const [id, timer] of [...due]) {
          if (timer.at > now) continue;
          due.delete(id);
          timer.run();
        }
      },
    };
  }

  test("before anything moves it, it is not moving and nothing is called", () => {
    const c = clock();
    let rests = 0;
    const rest = restTimer(() => rests++, c.scheduler);
    c.pass(REST_MS * 2);
    expect(rest.moving()).toBe(false);
    expect(rests).toBe(0);
  });

  test("it is moving from an event until the moment has passed, then at rest once", () => {
    const c = clock();
    let rests = 0;
    const rest = restTimer(() => rests++, c.scheduler);
    rest.moved();
    c.pass(REST_MS - 1);
    expect(rest.moving()).toBe(true);
    expect(rests).toBe(0);
    c.pass(1);
    expect(rest.moving()).toBe(false);
    c.pass(REST_MS * 2);
    expect(rests).toBe(1);
  });

  test("each event of a flick postpones the rest", () => {
    const c = clock();
    let rests = 0;
    const rest = restTimer(() => rests++, c.scheduler);
    rest.moved();
    c.pass(REST_MS - 1);
    rest.moved();
    c.pass(REST_MS - 1);
    expect(rests).toBe(0);
    c.pass(1);
    expect(rests).toBe(1);
  });

  test("at rest it is already not moving, so a place corrected there is written", () => {
    const c = clock();
    const seen: boolean[] = [];
    const rest = restTimer(() => seen.push(rest.moving()), c.scheduler);
    rest.moved();
    c.pass(REST_MS);
    expect(seen).toEqual([false]);
  });

  test("stopping it (the thread closing) cancels the rest", () => {
    const c = clock();
    let rests = 0;
    const rest = restTimer(() => rests++, c.scheduler);
    rest.moved();
    rest.stop();
    c.pass(REST_MS * 2);
    expect(rest.moving()).toBe(false);
    expect(rests).toBe(0);
  });
});

describe("a burst of scroll events mounts one chunk, not several", () => {
  test("the first update from a start moves it one chunk up", () => {
    expect(revealFrom(60)({ start: 60 })).toEqual({ start: 60 - CHUNK });
  });

  test("an update asked from a start that has already moved changes nothing", () => {
    const moved = { start: 60 - CHUNK };
    expect(revealFrom(60)(moved)).toBe(moved);
  });
});
