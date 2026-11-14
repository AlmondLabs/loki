import { describe, expect, test } from "vitest";
import { insertMention, mentionAt } from "../app/src/desk/mentions.tsx";
import { PickedPeople } from "../core/attention/picked-people.ts";

describe("the @ being typed in a reply (plan 082)", () => {
  test("an @ at the start, after a space or a bracket, with letters up to the caret", () => {
    expect(mentionAt("@ra", 3)).toEqual({ start: 0, query: "ra" });
    expect(mentionAt("hi @ravi.k", 10)).toEqual({ start: 3, query: "ravi.k" });
    expect(mentionAt("(@an) later", 4)).toEqual({ start: 1, query: "an" });
  });

  test("no list for a bare @, an @ before a space, an email address, a new line, or with the caret before the @", () => {
    expect(mentionAt("hi @", 4)).toBeNull();
    expect(mentionAt("hi @ ravi", 9)).toBeNull();
    expect(mentionAt("ravi@exa", 8)).toBeNull();
    expect(mentionAt("@ravi\nok", 8)).toBeNull();
    expect(mentionAt("hi @ravi", 2)).toBeNull();
  });

  test("a full name keeps the @ open across its spaces, so @Grace L narrows to Grace Lee (plan 2026-11-14-1530, R18)", () => {
    expect(mentionAt("@Grace L", 8)).toEqual({ start: 0, query: "Grace L" });
    expect(mentionAt("ask @Grace is", 13)).toEqual({ start: 4, query: "Grace is" });
  });

  test("a pick replaces what was typed after the @, adds a space, and puts the caret after it", () => {
    expect(insertMention("hi @ra, look", 3, 6, "ravi.kumar")).toEqual({ text: "hi @ravi.kumar , look", caret: 15 });
    expect(insertMention("@an", 0, 3, "Ana Rao")).toEqual({ text: "@Ana Rao ", caret: 9 });
  });
});

describe("the people picked from a reply box (plan 2026-11-14-1530, R23)", () => {
  test("a pick is mentioned by its account's send while its name is in the text; a name typed by hand is not", () => {
    const picked = new PickedPeople();
    picked.add("slack:T1:U1", { display: "Grace Lee", id: "U5", address: null });
    picked.add("slack:T1:U1", { display: "Grace Lee", id: "U5", address: null });
    expect(picked.in("slack:T1:U1", "@Grace Lee can you look")).toEqual([{ display: "Grace Lee", id: "U5", address: null }]);
    expect(picked.in("slack:T1:U1", "can you look")).toEqual([]);
    expect(picked.in("slack:T1:U1", "@Ravi Kumar can you look")).toEqual([]);
    expect(picked.in("slack:T2:U1", "@Grace Lee can you look")).toEqual([]);
  });
});
