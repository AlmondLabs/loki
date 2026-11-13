import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { popupEntries, tidyEntries, type MenuEntry } from "../app/src/shell/native-menu.ts";
import { rowMenuEntries } from "../app/src/shell/desk-sidebar.tsx";
import { effortTitle } from "../app/src/chat/model-picker.tsx";
import { stepEffort, switcherGroups } from "../app/src/chat/model-switcher.tsx";
import { modeMenuEntries, MODES } from "../app/src/chat/permission-mode.tsx";
import { laneMenuEntries } from "../app/src/desk/catch-up-parts.tsx";
import type { DeskSummary } from "../core/frame-types.ts";
import { ArchiveIcon, ArchiveRestoreIcon, FolderIcon, MailOpenIcon, PencilIcon, PinIcon, PinOffIcon, PlusIcon, TagIcon, type LucideIcon } from "lucide-react";
import type { AttentionItem } from "../core/attention/model.ts";
import type { ModelEntry } from "../core/models.ts";
import type { Lane } from "../core/attention/lanes.ts";

// Plan 2026-11-12-1505, U19 and U22: under Liquid Glass in the Mac app, menus and pickers are the system's, drawn by
// AppKit (src-tauri popup.rs), each action with the Lucide icon it has everywhere else. A browser cannot pop one up, so
// these read what each menu offers, as data, and the shape it reaches the shell in.

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

  test("the shell gets items, separators and submenus, with checks, keys, counts and the icon's picture", () => {
    const run = () => {};
    const png = [137, 80, 78, 71];
    const { entries } = popupEntries(
      [
        { type: "item", id: "open", label: "Open", run, keys: "cmd+o", icon: ArchiveIcon },
        { type: "separator" },
        { type: "item", id: "work", label: "Work", detail: "2", checked: true, run },
        // An icon not drawn (its picture failed) leaves the item without one.
        { type: "submenu", id: "more", label: "More", items: [{ type: "item", id: "x", label: "X", disabled: true, run, icon: TagIcon }] },
      ],
      (icon) => (icon === ArchiveIcon ? png : undefined),
    );
    expect(entries).toEqual([
      { type: "item", label: "Open", enabled: true, keys: "cmd+o", icon: png },
      { type: "separator" },
      { type: "item", label: "Work (2)", enabled: true, checked: true },
      { type: "submenu", label: "More", enabled: true, items: [{ type: "item", label: "X", enabled: false }] },
    ]);
  });

  test("the shell's answer is an item's index, depth first over items alone, so the right one runs", () => {
    const ran: string[] = [];
    const item = (id: string): MenuEntry => ({ type: "item", id, label: id, run: () => ran.push(id) });
    const { runs } = popupEntries([
      item("a"),
      { type: "separator" },
      { type: "submenu", id: "s", label: "S", items: [item("b"), { type: "separator" }, item("c")] },
      { type: "separator" },
      { type: "separator" },
      item("d"),
    ]);
    for (const run of runs) run();
    expect(ran).toEqual(["a", "b", "c", "d"]);
  });

  test("the menu bar's handler takes every click it hears: pop-up menus answer the page directly", () => {
    const keys = readFileSync(join(ROOT, "app", "src", "shell", "use-shell-keys.ts"), "utf8");
    expect(keys).not.toContain("POPUP");
    expect(readFileSync(join(ROOT, "src-tauri", "src", "menu.rs"), "utf8")).toContain('"Settings…"');
    expect(readFileSync(join(ROOT, "src-tauri", "src", "lib.rs"), "utf8")).toContain("popup::popup_menu");
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

  test("its actions carry the Lucide icon they have elsewhere, Archive and Mark as Read the toolbar's; Open carries none", () => {
    const icons = (entries: MenuEntry[]): Array<[string, LucideIcon | null]> =>
      tidyEntries(entries).flatMap((e): Array<[string, LucideIcon | null]> => (e.type === "item" ? [[e.label, e.icon ?? null]] : []));
    expect(icons(rowMenuEntries({ ...base, desk: desk() }))).toEqual([
      ["Open", null],
      ["Mark as Read", MailOpenIcon],
      ["Rename…", PencilIcon],
      ["Change Folder…", FolderIcon],
      ["Labels…", TagIcon],
      ["Pin", PinIcon],
      ["Archive", ArchiveIcon],
    ]);
    const pinned = icons(rowMenuEntries({ ...base, desk: desk({ pinned: true }) }));
    expect(pinned.filter(([label]) => label === "Unpin")).toEqual([["Unpin", PinOffIcon]]);
    const archived = icons(rowMenuEntries({ ...base, desk: desk({ status: "archived" }) }));
    expect(archived.filter(([label]) => label === "Restore")).toEqual([["Restore", ArchiveRestoreIcon]]);
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
    groups.map((g) => `${g.title}: ${g.rows.map((r) => `${r.name}${r.current ? " ✓" : ""}${r.off ? " (off)" : ""}`).join(", ")}`);

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
        .find((g) => g.id === "loki")
        ?.rows.find((r) => r.name === "GPT X")?.line,
    ).toBe("openai");
  });

  test("the agent's usual configurations lead with nothing typed, each with its effort, only ones the chat can take", () => {
    const usual = [
      { handle: "anthropic/claude-fable-5", reasoning_effort: "high" as const },
      { handle: "acp:fake/sonnet", reasoning_effort: null },
      { handle: "gone/model", reasoning_effort: null },
    ];
    const fresh = switcherGroups(entries, "anthropic/claude-fable-5", false, "", usual, "high");
    expect(fresh[0].title).toBe("Usual");
    expect(fresh[0].rows.map((r) => `${r.name} · ${r.line}${r.current ? " ✓" : ""}`)).toEqual(["Fable 5 · High effort · loki ✓", "Sonnet · Demo agent"]);
    expect(fresh[0].rows[0].effort).toBe("high");
    const started = switcherGroups(entries, "anthropic/claude-fable-5", true, "", usual, "medium");
    expect(started[0].rows.map((r) => `${r.name}${r.current ? " ✓" : ""}`)).toEqual(["Fable 5"]);
    expect(switcherGroups(entries, "anthropic/claude-fable-5", false, "gpt", usual).map((g) => g.title)).toEqual(["loki"]);
  });

  test("effort steps within what the model offers and stays at the ends; titles read as a Mac menu writes them", () => {
    expect(stepEffort(["low", "medium", "high"], "medium", 1)).toBe("high");
    expect(stepEffort(["low", "medium", "high"], "high", 1)).toBe("high");
    expect(stepEffort(["low", "medium", "high"], null, -1)).toBe("low");
    expect([effortTitle("none"), effortTitle("xhigh")]).toEqual(["No Reasoning", "X-High"]);
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

  test("a picker's choices carry no icon; only the action after them does", () => {
    const work: Lane = { id: "l-work", name: "Work", chats: "all", accounts: [] };
    const iconOf = (e: MenuEntry): LucideIcon | null | undefined => (e.type === "item" ? (e.icon ?? null) : undefined);
    expect(modeMenuEntries("standard", MODES, noop).map(iconOf)).toEqual([null, null, null, null]);
    const lanes = tidyEntries(laneMenuEntries({ lane: work, lanes: [work], items: [], onPick: noop, onNewLane: noop }));
    expect(lanes.map(iconOf)).toEqual([null, null, undefined, PlusIcon]);
  });
});
