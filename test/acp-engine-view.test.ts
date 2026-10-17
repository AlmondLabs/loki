import { describe, expect, test } from "vitest";
import { harnessOf, harnesses, type ChatEngineView, type ModelEntry } from "../core/models.ts";
import { engineCommands, LOKI_COMMANDS } from "../core/attention/commands.ts";
import { applyChatEvent, emptyLive } from "../core/attention/model.ts";
import { agentModes } from "../app/src/chat/permission-mode.tsx";

const CLAUDE: ChatEngineView = {
  agent: "claude-code",
  name: "Claude Code",
  model: "default",
  modes: [
    { id: "default", name: "Default", description: "asks before edits" },
    { id: "plan", name: "Plan", description: null },
    { id: "bypassPermissions", name: "Bypass Permissions", description: null },
  ],
  commands: [
    { name: "review", description: "review the changes", hint: "[branch]" },
    { name: "model", description: "Claude's own model command", hint: null },
  ],
};

const entry = (handle: string): ModelEntry => ({ id: handle, handle, label: handle });
const ENTRIES = [entry("anthropic/claude-fable-5"), entry("acp:claude-code/default"), entry("acp:claude-code/sonnet"), entry("acp:codex/default")];

describe("a chat's engine in the app (plan 020)", () => {
  test("every harness is open before the first message; after it, only the chat's own (plan 021)", () => {
    const tabs = (chat: string | null, started: boolean) => harnesses(ENTRIES, chat, started).map((h) => [h.id, h.name, h.locked]);
    expect(tabs(null, false)).toEqual([
      [null, "loki", false],
      ["claude-code", "acp:claude-code/default", false],
      ["codex", "acp:codex/default", false],
    ]);
    expect(tabs(null, true).filter((t) => !t[2])).toEqual([[null, "loki", false]]);
    expect(tabs("claude-code", true).filter((t) => !t[2])).toEqual([["claude-code", "acp:claude-code/default", false]]);
    expect(harnesses([], null, false)).toEqual([]);
    expect([harnessOf("acp:claude-code/sonnet"), harnessOf("anthropic/claude-fable-5"), harnessOf(null), harnessOf("acp:")]).toEqual([
      "claude-code",
      null,
      null,
      null,
    ]);
  });

  test("an ACP chat's commands: loki's, its passes, then the agent's, with loki's winning a shared name", () => {
    const ids = engineCommands(CLAUDE).map((c) => c.id);
    expect(ids).toEqual([...LOKI_COMMANDS.map((c) => c.id), "reflect", "doctor", "review"]);
    expect(engineCommands(CLAUDE).find((c) => c.id === "review")).toMatchObject({ where: "harness", args: "[branch]" });
  });

  test("the agent's modes in its own words; one that lets everything run is the open door", () => {
    const modes = agentModes(CLAUDE);
    expect(modes.map((m) => [m.id, m.short, m.fill])).toEqual([
      ["default", "default", 0.5],
      ["plan", "plan", 0.5],
      ["bypassPermissions", "bypass permissions", 0],
    ]);
    expect(modes[1].description).toBe("Claude Code's plan mode");
  });

  test("the engine arrives with the chat's state and leaves when the chat goes back to loki", () => {
    const l = emptyLive();
    expect(applyChatEvent(l, { kind: "device", engine: CLAUDE }).changed).toBe(true);
    expect(l.engine).toEqual(CLAUDE);
    expect(applyChatEvent(l, { kind: "device", engine: { ...CLAUDE } }).changed).toBe(false);
    expect(applyChatEvent(l, { kind: "device", mode: "plan" }).changed).toBe(true);
    expect(l.engine).toEqual(CLAUDE);
    expect(applyChatEvent(l, { kind: "device", engine: null }).changed).toBe(true);
    expect(l.engine).toBeNull();
  });
});
