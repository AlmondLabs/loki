import { describe, expect, test } from "vitest";
import { insertMention, mentionAt } from "../app/src/desk/mentions.tsx";

describe("the @ being typed in a reply (plan 082)", () => {
  test("an @ at the start, after a space or a bracket, with letters up to the caret", () => {
    expect(mentionAt("@ra", 3)).toEqual({ start: 0, query: "ra" });
    expect(mentionAt("hi @ravi.k", 10)).toEqual({ start: 3, query: "ravi.k" });
    expect(mentionAt("(@an) later", 4)).toEqual({ start: 1, query: "an" });
  });

  test("no list for a bare @, an email address, after a space, or with the caret before the @", () => {
    expect(mentionAt("hi @", 4)).toBeNull();
    expect(mentionAt("ravi@exa", 8)).toBeNull();
    expect(mentionAt("@ravi ", 6)).toBeNull();
    expect(mentionAt("hi @ravi", 2)).toBeNull();
  });

  test("a pick replaces what was typed after the @, adds a space, and puts the caret after it", () => {
    expect(insertMention("hi @ra, look", 3, 6, "ravi.kumar")).toEqual({ text: "hi @ravi.kumar , look", caret: 15 });
    expect(insertMention("@an", 0, 3, "Ana Rao")).toEqual({ text: "@Ana Rao ", caret: 9 });
  });
});
