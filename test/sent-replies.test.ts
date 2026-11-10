import { describe, expect, test } from "vitest";
import { createSentReplies, sentKey } from "../core/attention/sent-replies.ts";

const KEY = sentKey("slack:T1", "D1");
const AT = "2026-11-10T09:00:00.000Z";

describe("sent replies (plan 086)", () => {
  test("a reply shows from the press, is marked gone once it went, and counts toward the read again", () => {
    const s = createSentReplies();
    let told = 0;
    const stop = s.subscribe(KEY, () => (told += 1));
    const id = s.add(KEY, "on my way", AT);
    expect(s.get(KEY)).toEqual({ went: 0, replies: [{ id, text: "on my way", at: AT, gone: false, seq: 0 }] });
    s.went(id);
    expect(s.get(KEY)).toMatchObject({ went: 1, replies: [{ id, gone: true, seq: 1 }] });
    expect(told).toBe(2);
    stop();
    s.add(KEY, "again", AT);
    expect(told).toBe(2);
  });

  test("an undone or failed reply goes, and another thread keeps its own", () => {
    const s = createSentReplies();
    const other = sentKey("slack:T1", "D2");
    const id = s.add(KEY, "oops", AT);
    s.add(other, "elsewhere", AT);
    s.drop(id);
    expect(s.get(KEY)).toEqual({ went: 0, replies: [] });
    expect(s.get(other).replies).toMatchObject([{ text: "elsewhere" }]);
  });

  test("a read settles only the replies that went before it was made", () => {
    const s = createSentReplies();
    const first = s.add(KEY, "one", AT);
    s.went(first);
    const second = s.add(KEY, "two", AT);
    const third = s.add(KEY, "three", AT);
    s.went(third);
    // A read made after one had gone: the second is still on its way, the third went after the read began.
    s.settle(KEY, 1);
    expect(s.get(KEY).replies.map((r) => r.id)).toEqual([second, third]);
    s.went(second);
    s.settle(KEY, 3);
    expect(s.get(KEY)).toEqual({ went: 3, replies: [] });
  });

  test("the snapshot stays the same object until something changes", () => {
    const s = createSentReplies();
    expect(s.get(KEY)).toBe(s.get(KEY));
    s.add(KEY, "hi", AT);
    const snap = s.get(KEY);
    s.settle(KEY, 5);
    expect(s.get(KEY)).toBe(snap);
  });
});
