import { describe, expect, test } from "bun:test";
import { HARNESS_COMMANDS, LOKI_COMMANDS, allCommands, commandInput, matchCommands, parseSlash, slashQuery } from "../core/attention/commands.ts";

describe("slash commands", () => {
  test("parseSlash reads a command and its arguments, and leaves paths and prose alone", () => {
    expect(parseSlash("/reload")).toEqual({ id: "reload", args: "" });
    expect(parseSlash("  /compact all  ")).toEqual({ id: "compact", args: "all" });
    expect(parseSlash("/context-limit 200000 --override")).toEqual({ id: "context-limit", args: "200000 --override" });
    expect(parseSlash("/Users/trtl/notes.md")).toBeNull();
    expect(parseSlash("/tmp/x")).toBeNull();
    expect(parseSlash("look at /reload later")).toBeNull();
    expect(parseSlash("")).toBeNull();
  });
  test("slashQuery is the partial name while it is being typed, and nothing once arguments start", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/RE")).toBe("re");
    expect(slashQuery("/compact ")).toBeNull();
    expect(slashQuery("hello /re")).toBeNull();
  });
  test("matchCommands puts prefix matches first, then matches inside the name or description", () => {
    const ids = matchCommands("re", allCommands()).map((c) => c.id);
    expect(ids.slice(0, 2)).toEqual(["remember", "reflect"]);
    expect(ids).toContain("clear"); // "afresh" in its description
    expect(matchCommands("", allCommands()).length).toBe(LOKI_COMMANDS.length + HARNESS_COMMANDS.length);
    expect(matchCommands("zzz", allCommands())).toEqual([]);
  });
  test("commandInput is the line the harness echoes", () => {
    expect(commandInput("reflect")).toBe("/reflect");
    expect(commandInput("compact", "  all ")).toBe("/compact all");
  });
});
