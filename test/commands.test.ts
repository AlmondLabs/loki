import { describe, expect, test } from "vitest";
import {
  HARNESS_COMMANDS,
  LOKI_COMMANDS,
  allCommands,
  commandInput,
  engineCommands,
  matchCommands,
  parseSlash,
  phoneCommand,
  slashQuery,
} from "../core/attention/commands.ts";
import type { ChatEngineView } from "../core/models.ts";

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
    expect(ids).toContain("clear");
    expect(matchCommands("", allCommands()).length).toBe(LOKI_COMMANDS.length + HARNESS_COMMANDS.length);
    expect(matchCommands("zzz", allCommands())).toEqual([]);
  });
  test("/flow opens Flow, and /inbox, its old name, still does without being listed (plan 087, KTD12)", () => {
    const flow = LOKI_COMMANDS.find((c) => c.id === "flow");
    expect(flow?.action).toBe("segment.flow");
    expect(parseSlash("/flow")).toEqual({ id: "flow", args: "" });
    expect(parseSlash("/inbox")).toEqual({ id: "flow", args: "" });
    expect(allCommands().map((c) => c.id)).not.toContain("inbox");
    expect(matchCommands("inbox", allCommands()).map((c) => c.id)).not.toContain("inbox");
  });
  test("commandInput is the line the harness echoes", () => {
    expect(commandInput("reflect")).toBe("/reflect");
    expect(commandInput("compact", "  all ")).toBe("/compact all");
  });
  test("/advisor asks this chat's advisor, in loki's chats and an ACP agent's, which cannot take it over with its own", () => {
    const advisor = allCommands([], ["compact", "clear", "remember", "reflect", "doctor", "advisor"]).find((c) => c.id === "advisor");
    expect(advisor).toMatchObject({ description: "ask this chat's advisor", where: "harness" });
    const claude: ChatEngineView = {
      agent: "claude-code",
      name: "Claude Code",
      model: "default",
      modes: [],
      commands: [{ name: "advisor", description: "Claude's own", hint: null }],
    };
    const acp = engineCommands(claude).filter((c) => c.id === "advisor");
    expect(acp).toEqual([advisor]);
  });
  test("the phone runs a leading /advisor as a command, with what follows it as the question, and sends anything else as a message", () => {
    expect(phoneCommand("/advisor is this migration safe?")).toEqual({ id: "advisor", args: "is this migration safe?" });
    expect(phoneCommand("/advisor")).toEqual({ id: "advisor", args: "" });
    expect(phoneCommand("/compact")).toBeNull();
    expect(phoneCommand("ask /advisor later")).toBeNull();
  });
});
