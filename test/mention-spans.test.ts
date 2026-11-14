import { describe, expect, test } from "vitest";
import { liveMentions, mentionSpans, writeMentions } from "../core/mentions.ts";

const grace = { display: "Grace Lee", id: "U1" };
const gr = { display: "Grace", id: "U2" };
const vivek = { display: "Vivek Rao", id: "U3" };

describe("mentions in a reply's text (plan 2026-11-14-1530, KTD3)", () => {
  test("a stored mention counts only as @display, whole, the longer name first", () => {
    expect(mentionSpans("Thanks @Grace Lee, and @grace too.", [gr, grace]).map((s) => [s.start, s.end, s.mention.id])).toEqual([
      [7, 17, "U1"],
      [23, 29, "U2"],
    ]);
    expect(mentionSpans("@Grace Leeway and mail grace@Grace Lee", [grace])).toEqual([]);
  });

  test("anything that is not a stored mention stays text: @channel, an address, a handle the agent quoted", () => {
    expect(mentionSpans("@channel ping a@b.com about @types/node, @grace", [grace, vivek])).toEqual([]);
  });

  test("only mentions still in the text are live, so deleting one drops it", () => {
    expect(liveMentions("Over to @Vivek Rao.", [grace, vivek])).toEqual([vivek]);
    expect(liveMentions("Over to Vivek Rao.", [grace, vivek])).toEqual([]);
  });

  test("a service's markup is written from the live mentions alone", () => {
    expect(
      writeMentions(
        "Hi @Grace Lee & @bob",
        [grace],
        (t) => t.replace("&", "&amp;"),
        (m) => `<@${m.id}>`,
      ).join(""),
    ).toBe("Hi <@U1> &amp; @bob");
  });
});
