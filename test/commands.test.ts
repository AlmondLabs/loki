import { describe, expect, test } from "bun:test";
import { HARNESS_COMMANDS, LOKI_COMMANDS, allCommands, commandInput, fromAdvertised, matchCommands, parseSlash, slashQuery } from "../packages/core/src/attention/commands.ts";
import { applyEvent, emptyLive } from "../packages/core/src/attention/model.ts";

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
    expect(ids.slice(0, 2)).toEqual(["reload", "remember"]);
    expect(ids).toContain("init"); // "re-initialise" in its description
    expect(matchCommands("", allCommands()).length).toBe(LOKI_COMMANDS.length + HARNESS_COMMANDS.length);
    expect(matchCommands("zzz", allCommands())).toEqual([]);
  });
  test("fromAdvertised adds what the harness advertises beyond the table, mod commands with their text", () => {
    const extra = fromAdvertised(["reload", "toolset", "Bad Id"], [{ id: "memory-citations", description: "cite memory", args: "<query>" }, { id: "reload" }]);
    expect(extra).toEqual([
      { id: "toolset", description: "", where: "harness" },
      { id: "memory-citations", description: "cite memory", args: "<query>", where: "harness" },
    ]);
    expect(allCommands(extra).map((c) => c.id)).toContain("memory-citations");
  });
  test("commandInput is the line the harness echoes", () => {
    expect(commandInput("reload")).toBe("/reload");
    expect(commandInput("compact", "  all ")).toBe("/compact all");
  });
  test("slash_command_start / _end deltas become one event row: running, then the outcome", () => {
    const l = emptyLive();
    const delta = (d: Record<string, unknown>) => ({ type: "stream_delta", delta: d });
    applyEvent(l, delta({ message_type: "slash_command_start", command_id: "reload", input: "/reload" }));
    expect(l.tail).toEqual([{ role: "event", text: "/reload", summary: "running…" }]);
    applyEvent(l, delta({ message_type: "slash_command_end", command_id: "reload", input: "/reload", output: "Reloaded 2 mods.", success: true }));
    expect(l.tail).toEqual([{ role: "event", text: "/reload", summary: "Reloaded 2 mods.", detail: null }]);
    // A long output goes behind the disclosure; a failure says so.
    applyEvent(l, delta({ message_type: "slash_command_start", command_id: "compact", input: "/compact all" }));
    applyEvent(l, delta({ message_type: "slash_command_end", command_id: "compact", input: "/compact all", output: "line one\nline two", success: false }));
    expect(l.tail[1]).toEqual({ role: "event", text: "/compact all", summary: "failed", detail: "line one\nline two" });
    // An end without a start still lands as a row.
    applyEvent(l, delta({ message_type: "slash_command_end", command_id: "clear", input: "/clear", output: "Cleared.", success: true }));
    expect(l.tail[2]).toEqual({ role: "event", text: "/clear", summary: "Cleared.", detail: null });
  });
});
