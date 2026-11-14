import { afterEach, describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { matchCommands, matchModels } from "../app/src/shell/search-sheet.tsx";
import { commandsFor, registerActions, KEYMAP } from "../app/src/shell/keymap.ts";
import { openCommandCenter, takeCommandCenter, type SharedModels } from "../app/src/shell/command-center.ts";
import type { ModelEntry } from "../core/models.ts";

// Plan 2026-11-12-1505, U23: ⌘K is loki's one command panel: search, this screen's commands, the open chat's models.

const ROOT = join(import.meta.dirname, "..");
const entry = (handle: string, label: string): ModelEntry => ({ id: handle, handle, label });
const models = (over: Partial<SharedModels> = {}): SharedModels => ({
  entries: [
    entry("anthropic/claude-sonnet", "Sonnet"),
    entry("openai/gpt-x", "GPT X"),
    entry("anthropic/claude-opus", "Opus"),
    entry("x/sonnet-mini", "Sonnet Mini"),
    entry("y/sonnet-max", "Sonnet Max"),
  ],
  current: "openai/gpt-x",
  currentEffort: null,
  started: false,
  usual: [],
  agentName: "friday",
  pick: () => {},
  ...over,
});

describe("plain ⌘K's commands and models", () => {
  const release: Array<() => void> = [];
  afterEach(() => {
    for (const r of release.splice(0)) r();
  });

  test("commands are the menu-bar actions registered now and on this screen, with their keys; never ⌘K itself", () => {
    release.push(registerActions({ "desk.new": () => {}, "desk.done": () => {}, "inbox.archive": () => {}, "search.open": () => {} }));
    const chats = commandsFor("desk", "macos");
    expect(chats.map((c) => `${c.label} ${c.keys ?? ""}`)).toEqual(["New Chat ⌘N", "Mark as Read ⌘⇧↵"]);
    expect(commandsFor("inbox", "macos").map((c) => c.label)).toEqual(["New Chat", "Archive"]);
    expect(KEYMAP.find((b) => b.id === "search.open")?.menu).toBeTruthy();
  });

  test("a command matches when its label holds every word typed, and none show before typing", () => {
    const list = [
      { id: "desk.new", label: "New Chat…", keys: "⌘N" },
      { id: "desk.done", label: "Mark as Read", keys: null },
    ];
    expect(matchCommands(list, "")).toEqual([]);
    expect(matchCommands(list, "mark read").map((c) => c.id)).toEqual(["desk.done"]);
  });

  test("models show only with a chat open and something typed, at most three, names that start with the query first", () => {
    expect(matchModels(null, "son")).toEqual([]);
    expect(matchModels(models(), "")).toEqual([]);
    expect(matchModels(models(), "son").map((r) => r.name)).toEqual(["Sonnet", "Sonnet Mini", "Sonnet Max"]);
  });
});

describe("anything opens ⌘K on a scope; the open chat's models reach it", () => {
  test("openCommandCenter reaches the shell that took it, and nothing once released", () => {
    const opened: string[] = [];
    const release = takeCommandCenter((scope) => opened.push(scope));
    expect(openCommandCenter("models")).toBe(true);
    release();
    expect(openCommandCenter("all")).toBe(false);
    expect(opened).toEqual(["models"]);
  });

  test("the conversation shares its models and modes on the desktop, ⌘⇧M and ⌘⇧P open ⌘K on their scopes; the shell passes them on", () => {
    const conversation = readFileSync(join(ROOT, "app", "src", "chat", "conversation.tsx"), "utf8");
    expect(conversation).toContain("const inCommand = !touch && hasModelPicker;");
    expect(conversation).toContain("const modesInCommand = !touch && hasModeMenu;");
    expect(conversation).toContain('<OpenScope scope="models" open={controls.pickerOpen} onOpened={controls.closePicker} />');
    expect(conversation).toContain('<OpenScope scope="permissions" open={controls.modeOpen} onOpened={controls.closeMode} />');
    expect(conversation).toContain("openCommandCenter(scope);");
    const shell = readFileSync(join(ROOT, "app", "src", "shell", "shell.tsx"), "utf8");
    expect(shell).toContain("useEffect(() => takeCommandCenter(openSearch), [openSearch]);");
    expect(shell).toMatch(/models=\{sharedModels\}\s*commands=\{commandsFor\(segment\)\}/);
    const sheet = readFileSync(join(ROOT, "app", "src", "shell", "search-sheet.tsx"), "utf8");
    expect(sheet).toMatch(/top="10vh"\s+clear/);
    expect(sheet).toContain("const MODELS_PREFIX = /^models?\\s$/i;");
  });
});
