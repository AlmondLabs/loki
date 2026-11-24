import { describe, expect, test } from "vitest";
import type { TranscriptRow } from "../core/attention/transcript.ts";
import { isNewSend } from "../app/src/chat/use-transcript-scroll.ts";
import { drawnRows, keepsFollowing, lastShown, newSince, nextAbove, readerScrolling, revealFrom } from "../app/src/item/thread-follow.ts";
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

describe("older rows load a few screens before you reach them while you scroll up", () => {
  const scrolling = { scrolling: true, hiddenAbove: true, olderToAsk: false };
  const opening = { ...scrolling, scrolling: false };

  test("scrolling, three screens from the top of what is loaded mounts the next rows, well before the old 800px", () => {
    expect(nextAbove({ scrollTop: 1500, clientHeight: 700 }, scrolling)).toBe("reveal");
    expect(nextAbove({ scrollTop: 2500, clientHeight: 700 }, scrolling)).toBe("far");
  });

  test("in a short window the distance is never less than 800px", () => {
    expect(nextAbove({ scrollTop: 600, clientHeight: 200 }, scrolling)).toBe("reveal");
  });

  test("without the reader scrolling (opening, find, Latest) the distance stays 800px", () => {
    expect(nextAbove({ scrollTop: 1500, clientHeight: 700 }, opening)).toBe("far");
    expect(nextAbove({ scrollTop: 700, clientHeight: 700 }, opening)).toBe("reveal");
  });

  test("with every row drawn, the daemon is asked for an older page from the same distance, once per length", () => {
    expect(nextAbove({ scrollTop: 2500, clientHeight: 700 }, { scrolling: true, hiddenAbove: false, olderToAsk: true })).toBe("far");
    expect(nextAbove({ scrollTop: 1500, clientHeight: 700 }, { scrolling: true, hiddenAbove: false, olderToAsk: true })).toBe("older");
    expect(nextAbove({ scrollTop: 1500, clientHeight: 700 }, { scrolling: true, hiddenAbove: false, olderToAsk: false })).toBeNull();
  });

  test("a hidden pane counts as far from the top, so nothing is mounted or asked for", () => {
    expect(nextAbove({ scrollTop: 0, clientHeight: 0 }, scrolling)).toBe("far");
  });
});

describe("the reader counts as scrolling for a second after their own wheel, key or touch", () => {
  test("before any input of theirs (a chat opening), a scroll is the code's own", () => {
    expect(readerScrolling(500, Number.NEGATIVE_INFINITY)).toBe(false);
  });

  test("a scroll within the second after their input is theirs, one a second later is not", () => {
    expect(readerScrolling(1999, 1000)).toBe(true);
    expect(readerScrolling(2000, 1000)).toBe(false);
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
