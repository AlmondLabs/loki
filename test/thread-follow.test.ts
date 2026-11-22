import { describe, expect, test } from "vitest";
import type { TranscriptRow } from "../core/attention/transcript.ts";
import { isNewSend } from "../app/src/chat/use-transcript-scroll.ts";
import { drawnRows, keepsFollowing, lastShown, newSince } from "../app/src/item/thread-follow.ts";

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
