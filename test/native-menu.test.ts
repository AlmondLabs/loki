import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nativeOptions, tidyEntries, POPUP, type MenuEntry } from "../app/src/shell/native-menu.ts";
import { rowMenuEntries } from "../app/src/shell/desk-sidebar.tsx";
import { effortTitle } from "../app/src/chat/model-picker.tsx";
import { stepEffort, switcherGroups } from "../app/src/chat/model-switcher.tsx";
import { modeMenuEntries, MODES } from "../app/src/chat/permission-mode.tsx";
import { laneMenuEntries } from "../app/src/desk/catch-up-parts.tsx";
import type { DeskSummary } from "../core/frame-types.ts";
import type { AttentionItem } from "../core/attention/model.ts";
import type { ModelEntry } from "../core/models.ts";
import type { Lane } from "../core/attention/lanes.ts";

// Plan 2026-11-12-1505, U19: under Liquid Glass in the Mac app, menus and pickers are the system's. A browser cannot
// pop one up, so these read what each menu offers, as data, and how it reaches Tauri.

const ROOT = join(import.meta.dirname, "..");
const noop = () => {};
const labels = (entries: MenuEntry[]): string[] =>
  tidyEntries(entries).map((e) =>
    e.type === "separator" ? "—" : e.type === "submenu" ? `${e.label} ▸` : `${e.label}${e.checked ? " ✓" : ""}${e.disabled ? " (off)" : ""}`,
  );

describe("a menu as data", () => {
  test("separators only between groups: none leading, trailing or doubled, and an empty submenu goes", () => {
    const item = (id: string): MenuEntry => ({ type: "item", id, label: id, run: noop });
    const entries: MenuEntry[] = [
      { type: "separator" },
      item("a"),
      { type: "separator" },
      { type: "separator" },
      { type: "submenu", id: "s", label: "S", items: [{ type: "separator" }] },
      item("b"),
      { type: "separator" },
    ];
    expect(labels(entries)).toEqual(["a", "—", "b"]);
  });

  test("Tauri gets plain options: popup ids, checks, accelerators, counts and nested submenus", () => {
    const run = () => {};
    const options = nativeOptions([
      { type: "item", id: "open", label: "Open", run, keys: "cmd+o" },
      { type: "separator" },
      { type: "item", id: "work", label: "Work", detail: "2", checked: true, run },
      { type: "submenu", id: "more", label: "More", items: [{ type: "item", id: "x", label: "X", disabled: true, run }] },
    ]);
    expect(options).toEqual([
      { id: `${POPUP}open`, text: "Open", enabled: true, accelerator: "CmdOrCtrl+O", action: run },
      { item: "Separator" },
      { id: `${POPUP}work`, text: "Work (2)", enabled: true, checked: true, action: run },
      { id: `${POPUP}more`, text: "More", enabled: true, items: [{ id: `${POPUP}x`, text: "X", enabled: false, action: run }] },
    ]);
  });

  test("the menu bar's handler skips a popped-up item's click, whose own action already ran", () => {
    const keys = readFileSync(join(ROOT, "app", "src", "shell", "use-shell-keys.ts"), "utf8");
    expect(keys).toContain("if (ev.payload.startsWith(POPUP)) return;");
    expect(readFileSync(join(ROOT, "src-tauri", "src", "menu.rs"), "utf8")).toContain('"Settings…"');
  });
});

describe("the chat row's menu", () => {
  const desk = (over: Partial<DeskSummary> = {}): DeskSummary => ({
    scope: "s1",
    title: "Signups",
    status: "live",
    agent_name: "friday",
    agent_id: "a1",
    conversation_id: "c1",
    model: null,
    reasoning_effort: null,
    pinned: false,
    widgets: 0,
    active: false,
    last_active: "2026-11-13T10:00:00Z",
    ...over,
  });
  const unread = { id: "c1", agent_id: "a1", status: "finished", unread: true } as unknown as AttentionItem;
  const base = {
    item: unread,
    connected: true,
    onOpen: noop,
    onPin: noop,
    onArchive: noop,
    onRename: noop,
    onMove: noop,
    onLabels: noop,
    onDone: noop,
    targets: [],
  };

  test("open and read state, then what changes the chat, then pin and archive, in title case", () => {
    expect(labels(rowMenuEntries({ ...base, desk: desk() }))).toEqual([
      "Open",
      "Mark as Read",
      "—",
      "Rename…",
      "Change Folder…",
      "Labels…",
      "—",
      "Pin",
      "Archive",
    ]);
    expect(labels(rowMenuEntries({ ...base, item: null, desk: desk({ pinned: true }) }))).toEqual([
      "Open",
      "—",
      "Rename…",
      "Change Folder…",
      "Labels…",
      "—",
      "Unpin",
      "Archive",
    ]);
  });

  test("with the link down, what needs it is off and says why when drawn", () => {
    const entries = rowMenuEntries({ ...base, connected: false, desk: desk() });
    expect(labels(entries)).toEqual(["Open", "Mark as Read", "—", "Rename… (off)", "Change Folder… (off)", "Labels… (off)", "—", "Pin", "Archive (off)"]);
    const rename = entries.find((e) => e.type === "item" && e.id === "rename");
    expect(rename?.type === "item" && rename.hint).toBeTruthy();
  });
});

describe("Switch model, ⌘K's way", () => {
  const entry = (handle: string, label: string, over: Partial<ModelEntry> = {}): ModelEntry => ({
    id: `${handle}:${over.reasoning_effort ?? ""}`,
    handle,
    label,
    ...over,
  });
  const entries: ModelEntry[] = [
    entry("anthropic/claude-fable-5", "Fable 5", { is_featured: true, reasoning_effort: "low" }),
    entry("anthropic/claude-fable-5", "Fable 5", { is_featured: true, reasoning_effort: "medium" }),
    entry("anthropic/claude-fable-5", "Fable 5", { is_featured: true, reasoning_effort: "high" }),
    entry("openai/gpt-x", "GPT X", { is_featured: true }),
    entry("anthropic/claude-sonnet-old", "Sonnet Old"),
    entry("openai/gpt-old", "GPT Old"),
    entry("acp:fake/default", "Demo agent", { is_default: true }),
    entry("acp:fake/sonnet", "Demo agent · Sonnet"),
  ];
  const shape = (groups: ReturnType<typeof switcherGroups>) =>
    groups.map((g) => `${g.harness.name}: ${g.rows.map((r) => `${r.name}${r.current ? " ✓" : ""}${r.off ? " (off)" : ""}`).join(", ")}`);

  test("with nothing typed, the chat's harness first with loki's quick picks, then the other agent", () => {
    expect(shape(switcherGroups(entries, "anthropic/claude-fable-5", false, ""))).toEqual(["loki: Fable 5 ✓, GPT X", "Demo agent: Default, Sonnet"]);
  });

  test("typing searches every harness and provider, each word must match, names that start with it first", () => {
    expect(shape(switcherGroups(entries, "anthropic/claude-fable-5", false, "son"))).toEqual(["loki: Sonnet Old", "Demo agent: Sonnet"]);
    expect(shape(switcherGroups(entries, null, false, "openai old"))).toEqual(["loki: GPT Old"]);
    expect(switcherGroups(entries, null, false, "nothing like it")).toEqual([]);
  });

  test("once the chat has started, only its own agent's models, under its name; no handle is a name", () => {
    const groups = switcherGroups(entries, "acp:fake/sonnet", true, "");
    expect(shape(groups)).toEqual(["Demo agent: Default, Sonnet ✓"]);
    expect(shape(switcherGroups(entries, "acp:fake/sonnet", true, "gpt"))).toEqual([]);
    expect(groups.flatMap((g) => g.rows.map((r) => r.name)).join(" ")).not.toContain("acp:");
    expect(groups[0].rows.find((r) => r.name === "Sonnet")?.line).toBeNull();
    expect(
      switcherGroups(entries, "anthropic/claude-fable-5", true, "")
        .find((g) => g.harness.id === null)
        ?.rows.find((r) => r.name === "GPT X")?.line,
    ).toBe("openai");
  });

  test("effort steps within what the model offers and stays at the ends; titles read as a Mac menu writes them", () => {
    expect(stepEffort(["low", "medium", "high"], "medium", 1)).toBe("high");
    expect(stepEffort(["low", "medium", "high"], "high", 1)).toBe("high");
    expect(stepEffort(["low", "medium", "high"], null, -1)).toBe("low");
    expect([effortTitle("none"), effortTitle("xhigh")]).toEqual(["No Reasoning", "X-High"]);
  });

  test("under Liquid Glass on the desktop the pill and ⌘⇧M open the switcher; nothing dims behind it", () => {
    const conversation = readFileSync(join(ROOT, "app", "src", "chat", "conversation.tsx"), "utf8");
    expect(conversation).toMatch(/glass && !touch \? \(\s*controls\.pickerOpen && \(\s*<ModelSwitcher/);
    expect(readFileSync(join(ROOT, "app", "src", "chat", "model-switcher.tsx"), "utf8")).toContain('top="12vh" clear');
  });
});

describe("the mode and lane menus", () => {
  test("the permission modes in title case, the current one checked; unset reads as unrestricted", () => {
    expect(labels(modeMenuEntries("acceptEdits", MODES, noop))).toEqual(["Strict", "Standard", "Accept Edits ✓", "Unrestricted"]);
    expect(labels(modeMenuEntries(null, MODES, noop)).at(-1)).toBe("Unrestricted ✓");
  });

  test("Flow's lanes: Everything, the person's lanes, then New Lane…", () => {
    const work: Lane = { id: "l-work", name: "Work", chats: "all", accounts: [] };
    expect(labels(laneMenuEntries({ lane: work, lanes: [work], items: [], onPick: noop, onNewLane: noop }))).toEqual([
      "Everything",
      "Work ✓",
      "—",
      "New Lane…",
    ]);
    expect(labels(laneMenuEntries({ lane: null, lanes: [], items: [], onPick: noop }))).toEqual(["Everything ✓"]);
  });
});
