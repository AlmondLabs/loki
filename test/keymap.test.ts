import { describe, expect, test } from "bun:test";
import { KEYMAP, conflicts, takenBy, formatKeys, matches, menuSpec, resolve, tauriAccelerator, chordIds, dialogState, keySegment, shellKeyAllowed, keysOf, keyFor, keyRows, wasFor, cmdHeld, type Binding } from "../app/src/shell/keymap.ts";
import { keysFor } from "../app/src/shell/KeysSheet.tsx";
import { SEGMENTS } from "../app/src/shell/shortcuts.ts";
import { commandText } from "../app/src/chat/SlashPalette.tsx";
import { platform, platformFrom, type Platform } from "../app/src/desk/env.ts";
import { LOKI_COMMANDS } from "../core/attention/commands.ts";

const ev = (key: string, mods: Partial<{ meta: boolean; ctrl: boolean; shift: boolean; alt: boolean }> = {}, typing = false) =>
  ({ key, metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, target: typing ? { tagName: "TEXTAREA" } : { tagName: "DIV" } }) as unknown as KeyboardEvent;

describe("keymap: table hygiene", () => {
  test("no two bindings share a key in one scope", () => {
    expect(conflicts()).toEqual([]);
  });
  test("ids are unique", () => {
    const ids = KEYMAP.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  test("every menu item has a label fit for a menu (capitalised, no trailing key hints)", () => {
    for (const b of KEYMAP.filter((b) => b.menu)) {
      expect(b.label[0]).toBe(b.label[0].toUpperCase());
      expect(b.label).not.toMatch(/[⌘⇧⌥]/);
    }
  });
});

describe("keymap: matching", () => {
  test("cmd matches ⌘ or ctrl, and shifted digits arrive as symbols", () => {
    expect(matches(ev("k", { meta: true }), "cmd+k")).toBe(true);
    expect(matches(ev("k", { ctrl: true }), "cmd+k")).toBe(true);
    expect(matches(ev("k"), "cmd+k")).toBe(false);
    expect(matches(ev("0", { meta: true, shift: true }), "cmd+shift+0")).toBe(true);
    expect(matches(ev(")", { meta: true, shift: true }), "cmd+shift+0")).toBe(true);
    expect(matches(ev("0", { meta: true }), "cmd+shift+0")).toBe(false);
    expect(matches(ev("]", { meta: true }), "cmd+]")).toBe(true);
    expect(matches(ev("ArrowRight", { meta: true, alt: true }), "alt+cmd+right")).toBe(true);
    expect(matches(ev("ArrowRight", { meta: true }), "alt+cmd+right")).toBe(false);
    expect(matches(ev("A", { shift: true }), "a")).toBe(false);
    expect(matches(ev("Enter", { meta: true }), "cmd+enter")).toBe(true);
  });
});

describe("keymap: resolution", () => {
  test("⌘[ and ⌘] step what each section is made of, never the next desk from elsewhere", () => {
    const next = (segment: Parameters<typeof resolve>[1]) => resolve(ev("]", { meta: true }), segment)?.id;
    const prev = (segment: Parameters<typeof resolve>[1]) => resolve(ev("[", { meta: true }), segment)?.id;
    expect([next("desk"), prev("desk")]).toEqual(["desk.next", "desk.prev"]);
    expect([next("inbox"), prev("inbox")]).toEqual(["inbox.next", "inbox.later"]);
    expect([next("board"), prev("board")]).toEqual(["board.nextColumn", "board.prevColumn"]);
    expect([next("learn"), prev("learn")]).toEqual(["learn.nextView", "learn.prevView"]);
    expect([next("agents"), prev("agents")]).toEqual(["agents.next", "agents.prev"]);
    expect([next("settings"), prev("settings")]).toEqual(["settings.nextPage", "settings.prevPage"]);
    // and while typing in the section's own box (the board filter, the reply box)
    expect(resolve(ev("]", { meta: true }, true), "board")?.id).toBe("board.nextColumn");
  });
  test("plain letters never fire inside a text box; chords marked typing do", () => {
    expect(resolve(ev("a"), "inbox")?.id).toBe("inbox.approve");
    expect(resolve(ev("a", {}, true), "inbox")).toBeNull();
    expect(resolve(ev("Enter", { meta: true }, true), "inbox")?.id).toBe("inbox.approve");
    expect(resolve(ev("z", { meta: true }, true), "inbox")).toBeNull(); // the text's undo
    expect(resolve(ev("d", { meta: true, shift: true }, true), "inbox")?.id).toBe("inbox.deny");
    expect(resolve(ev("Backspace", { meta: true }, true), "inbox")).toBeNull(); // the text's delete-to-line-start
    expect(resolve(ev("ArrowLeft", { meta: true }, true), "desk")).toBeNull(); // the caret's
    expect(resolve(ev("ArrowLeft", { meta: true, alt: true }, true), "desk")?.id).toBe("chat.left");
  });
  test("? opens the cheat sheet anywhere, never from inside a text box", () => {
    expect(resolve(ev("?", { shift: true }), "board")?.id).toBe("keys.sheet");
    expect(resolve(ev("?", { shift: true }), "learn")?.id).toBe("keys.sheet");
    expect(resolve(ev("?", { shift: true }, true), "inbox")).toBeNull();
    expect(resolve(ev("/"), "board")?.id).toBe("board.filter"); // the unshifted key keeps its own meaning
  });
  test("⌘⇧D shows and hides the list column (Slack's sidebar key), and stays Deny in the inbox, which has no column", () => {
    const shiftD = (segment: Parameters<typeof resolve>[1], typing = false) => resolve(ev("d", { meta: true, shift: true }, typing), segment)?.id;
    expect([shiftD("desk"), shiftD("board"), shiftD("agents"), shiftD("learn")]).toEqual(["column.toggle", "column.toggle", "column.toggle", "column.toggle"]);
    expect(shiftD("desk", true)).toBe("column.toggle");
    expect(shiftD("inbox")).toBe("inbox.deny");
  });
  test("segments and settings comma", () => {
    expect(resolve(ev(",", { meta: true }), "board")?.id).toBe("segment.settings");
    expect(resolve(ev("4", { meta: true }), "desk")?.id).toBe("segment.agents");
    expect(resolve(ev("5", { meta: true }), "desk")?.id).toBe("segment.learn");
    expect(resolve(ev("6", { meta: true }), "desk")?.id).toBe("segment.settings");
  });
});

describe("keymap: presentation", () => {
  test("⌘⇧D is listed where it does what it says: the sidebar outside the inbox, Deny in it", () => {
    const toggle = KEYMAP.find((b) => b.id === "column.toggle")!;
    expect(takenBy(toggle)).toEqual([{ where: "inbox", key: "cmd+shift+d", id: "inbox.deny", label: "Deny" }]);
    // no other key that works everywhere is taken by a view
    for (const b of KEYMAP.filter((b) => b.where === "anywhere" && b.id !== "column.toggle")) expect(takenBy(b)).toEqual([]);
    const everywhere = (segment: Parameters<typeof keysFor>[0]) => keysFor(segment).find((g) => g.where === "anywhere")!.rows.map((b) => b.id);
    expect(everywhere("inbox")).not.toContain("column.toggle");
    expect(keysFor("inbox").find((g) => g.where === "inbox")!.rows.map((b) => b.id)).toContain("inbox.deny");
    for (const s of ["desk", "board", "agents", "learn"] as const) expect(everywhere(s)).toContain("column.toggle");
  });
  test("formats chords with Mac symbols", () => {
    expect(formatKeys("shift+/")).toBe("?");
    expect(formatKeys("cmd+shift+a")).toBe("⌘⇧A");
    expect(formatKeys("cmd+]")).toBe("⌘]");
    expect(formatKeys("shift+backspace")).toBe("⇧⌫");
    expect(formatKeys("alt+space")).toBe("⌥space");
  });
  test("tauri accelerators use code names for punctuation and digits", () => {
    expect(tauriAccelerator("cmd+]")).toBe("CmdOrCtrl+BracketRight");
    expect(tauriAccelerator("cmd+shift+0")).toBe("CmdOrCtrl+Shift+Digit0");
    expect(tauriAccelerator("cmd+,")).toBe("CmdOrCtrl+Comma");
    expect(tauriAccelerator("cmd+k")).toBe("CmdOrCtrl+K");
  });
  test("the menu spec groups with separators and omits accelerators the text needs", () => {
    const spec = menuSpec();
    const inbox = spec.find((m) => m.title === "Inbox")!;
    expect(inbox.items.some((i) => "separator" in i)).toBe(true);
    const undo = inbox.items.find((i) => "id" in i && i.id === "inbox.undo") as { accelerator: string | null };
    expect(undo.accelerator).toBeNull(); // ⌘Z is the text's while typing; the menu must not steal it
    const approve = inbox.items.find((i) => "id" in i && i.id === "inbox.approve") as { accelerator: string | null };
    expect(approve.accelerator).toBe("CmdOrCtrl+Enter");
  });
  test("a chord names every binding it could mean, so the menu's echo of the other one is dropped", () => {
    expect(chordIds(ev("]", { meta: true })).sort()).toEqual(["agents.next", "board.nextColumn", "desk.next", "inbox.next", "learn.nextView", "settings.nextPage"]);
    expect(chordIds(ev("k", { meta: true }))).toEqual(["search.open"]);
  });
});

describe("keymap: ⌘K is search (plan 013 U9)", () => {
  test("⌘K opens search from anywhere, the message box included, and the native menu lists it as Search", () => {
    expect(resolve(ev("k", { meta: true }), "desk")?.id).toBe("search.open");
    expect(resolve(ev("k", { meta: true }, true), "desk")?.id).toBe("search.open"); // typing in the composer
    expect(resolve(ev("k", { meta: true }, true), "board")?.id).toBe("search.open");
    expect(KEYMAP.some((b) => b.id === "tree.toggle")).toBe(false);
    const item = menuSpec()
      .flatMap((m) => m.items.map((i) => ({ menu: m.title, ...i })))
      .find((i) => "id" in i && i.id === "search.open") as { menu: string; label: string; accelerator: string | null };
    expect(item).toMatchObject({ menu: "Desk", label: "Search", accelerator: "CmdOrCtrl+K" });
  });
  test("search up lets only ⌘K through (it closes it); a sheet over it wins", () => {
    const el = (attrs: string[]) => ({ hasAttribute: (a: string) => attrs.includes(a) });
    const root = (...dialogs: string[][]) => ({ querySelectorAll: () => dialogs.map(el) }) as unknown as ParentNode;
    expect(dialogState(root(["data-search"]))).toBe("search");
    expect(dialogState(root(["data-search"], []))).toBe("other");
    expect(shellKeyAllowed("search", "search.open")).toBe(true);
    for (const id of ["segment.desk", "desk.new", "keys.sheet", "chat.focus"]) expect(shellKeyAllowed("search", id)).toBe(false);
    expect(keySegment("board", "search")).toBe("board");
  });
});

describe("keymap: Preferences over the shell (KTD11)", () => {
  const el = (attrs: string[]) => ({ hasAttribute: (a: string) => attrs.includes(a) });
  const root = (...dialogs: string[][]) => ({ querySelectorAll: () => dialogs.map(el) }) as unknown as ParentNode;
  test("the dialogs up: none, only Preferences, or another one (which wins, even over Preferences)", () => {
    expect(dialogState(root())).toBe("none");
    expect(dialogState(root(["data-preferences"]))).toBe("preferences");
    expect(dialogState(root([]))).toBe("other");
    expect(dialogState(root(["data-preferences"], []))).toBe("other"); // a confirmation sheet over Preferences
  });
  test("Preferences lets ⌘, ⌘1-6 and ⌘[ ⌘] through; every other dialog blocks every shell key", () => {
    for (const id of ["segment.desk", "segment.inbox", "segment.board", "segment.agents", "segment.learn", "segment.settings", "settings.prevPage", "settings.nextPage"]) {
      expect(shellKeyAllowed("preferences", id)).toBe(true);
      expect(shellKeyAllowed("other", id)).toBe(false);
      expect(shellKeyAllowed("none", id)).toBe(true);
    }
    for (const id of ["desk.new", "task.new", "keys.sheet", "column.toggle", "search.open", "desk.next", "chat.focus"]) {
      expect(shellKeyAllowed("preferences", id)).toBe(false);
    }
  });
  test("with Preferences up, keys resolve as the settings scope: ⌘] steps its pages, ⌘2 is still the inbox", () => {
    const seg = keySegment("board", "preferences");
    expect(seg).toBe("settings");
    expect(resolve(ev("]", { meta: true }), seg)?.id).toBe("settings.nextPage");
    expect(resolve(ev("[", { meta: true }, true), seg)?.id).toBe("settings.prevPage");
    expect(resolve(ev("2", { meta: true }), seg)?.id).toBe("segment.inbox");
    expect(resolve(ev(",", { meta: true }, true), seg)?.id).toBe("segment.settings");
    expect(keySegment("board", "none")).toBe("board");
  });
});

describe("keymap: Mark as done", () => {
  test("⌘⇧↵ marks the open desk done, from the message box too; it is taken by nothing else, and ⌘↵ stays Approve and Dispatch", () => {
    expect(chordIds(ev("Enter", { meta: true, shift: true }))).toEqual(["desk.done"]);
    expect(resolve(ev("Enter", { meta: true, shift: true }), "desk")?.id).toBe("desk.done");
    expect(resolve(ev("Enter", { meta: true, shift: true }, true), "desk")?.id).toBe("desk.done");
    expect(resolve(ev("Enter", { meta: true, shift: true }, true), "inbox")).toBeNull();
    expect(resolve(ev("Enter", { meta: true }, true), "inbox")?.id).toBe("inbox.approve");
    expect(resolve(ev("Enter", { shift: true }, true), "desk")).toBeNull(); // the box's new line
    expect(tauriAccelerator("cmd+shift+enter")).toBe("CmdOrCtrl+Shift+Enter");
  });
});

describe("keymap: each system's keys (plan 014 U2)", () => {
  const PC: Platform[] = ["windows", "linux"];
  const MAC_KEYS = /[⌘⌥⇧⌃⌫↵⏎⇥]/;
  /** formatKeys as it was before per-system keys: the Mac's rendering must not move by a byte. */
  const MAC_BEFORE: Record<string, string> = { cmd: "⌘", shift: "⇧", alt: "⌥", ctrl: "⌃", enter: "↵", backspace: "⌫", escape: "esc", space: "space", left: "←", right: "→", up: "↑", down: "↓" };
  const macBefore = (spec: string) => (spec === "shift+/" ? "?" : spec.split("+").map((p) => MAC_BEFORE[p] ?? (p.length === 1 ? p.toUpperCase() : p)).join(""));

  test("covers AE5: Ctrl words on Windows and Linux, the Mac's symbols unchanged", () => {
    expect(formatKeys("cmd+k", "windows")).toBe("Ctrl K");
    expect(formatKeys("cmd+shift+enter", "linux")).toBe("Ctrl Shift Enter");
    expect(formatKeys("cmd+k", "macos")).toBe("⌘K");
    expect(platform).toBe("macos"); // the tests run as the Mac: no shell, no browser
    expect(formatKeys("cmd+k")).toBe("⌘K");
  });
  test("every named key has a word off the Mac; arrows and the one shifted chord read the same everywhere", () => {
    expect(formatKeys("alt+space", "windows")).toBe("Alt Space");
    expect(formatKeys("shift+backspace", "linux")).toBe("Shift Backspace");
    expect(formatKeys("backspace", "windows")).toBe("Backspace");
    expect(formatKeys("enter", "linux")).toBe("Enter");
    expect(formatKeys("escape", "windows")).toBe("Esc");
    expect(formatKeys("tab", "windows")).toBe("Tab");
    expect(formatKeys("tab", "macos")).toBe("⇥");
    expect(formatKeys("ctrl+x", "linux")).toBe("Ctrl X");
    expect(formatKeys("cmd+]", "windows")).toBe("Ctrl ]");
    expect(formatKeys("cmd+shift+0", "windows")).toBe("Ctrl Shift 0");
    expect(formatKeys("shift+/", "windows")).toBe("?");
    expect(formatKeys("left", "windows")).toBe("←");
    expect(formatKeys("cmd+left", "linux")).toBe("Ctrl ←");
    for (const os of PC) for (const b of KEYMAP) for (const k of keysOf(b, os)) expect(formatKeys(k, os)).not.toMatch(MAC_KEYS);
  });
  test("the Mac renders every key in the table byte for byte as before", () => {
    for (const b of KEYMAP) {
      expect(keysOf(b, "macos")).toBe(b.keys);
      for (const k of b.keys) expect(formatKeys(k, "macos")).toBe(macBefore(k));
    }
    expect(SEGMENTS.map((s) => s.key)).toEqual(["⌘1", "⌘2", "⌘3", "⌘4", "⌘5", "⌘6"]);
    expect(wasFor(KEYMAP.find((b) => b.id === "search.open")!, "macos")).toBe("was the desks tree: desks are in the sidebar now (⌘⇧D shows or hides it)");
    expect(menuSpec(KEYMAP, "macos")).toEqual(menuSpec());
  });
  test("covers AE5: Ctrl+K opens search on Windows, from the message box too, and the keys sheet lists it as Ctrl K", () => {
    expect(matches(ev("k", { ctrl: true }), "cmd+k")).toBe(true);
    expect(resolve(ev("k", { ctrl: true }), "desk", "windows")?.id).toBe("search.open");
    expect(resolve(ev("k", { ctrl: true }, true), "inbox", "windows")?.id).toBe("search.open");
    const row = keysFor("desk", KEYMAP, "windows").find((g) => g.where === "anywhere")!.rows.find((b) => b.id === "search.open")!;
    expect(row.keys.map((k) => formatKeys(k, "windows"))).toEqual(["Ctrl K"]);
    expect(keyFor("search.open", "windows")).toBe("Ctrl K");
    expect(keyFor("search.open", "linux")).toBe("Ctrl K");
  });
  test("off the Mac no binding takes a key the system keeps, nor any Ctrl+Alt chord (AltGr on Windows, workspaces on Linux)", () => {
    // Windows: Ctrl+Alt+arrows rotate the screen (Intel graphics), Alt+Space is the window menu, Ctrl+Esc the Start menu.
    // Linux (GNOME and friends): Ctrl+Alt+arrows switch workspaces, Alt+Space is the window menu, Ctrl+Alt+T a terminal.
    const RESERVED: Record<"windows" | "linux", string[]> = {
      windows: ["alt+cmd+left", "alt+cmd+right", "alt+cmd+up", "alt+cmd+down", "alt+space", "cmd+escape", "cmd+shift+escape"],
      linux: ["alt+cmd+left", "alt+cmd+right", "alt+cmd+up", "alt+cmd+down", "alt+space", "alt+cmd+t", "alt+cmd+backspace"],
    };
    for (const os of ["windows", "linux"] as const) {
      const used = KEYMAP.flatMap((b) => keysOf(b, os).map((k) => ({ id: b.id, k })));
      expect(used.filter(({ k }) => RESERVED[os].includes(k))).toEqual([]);
      expect(used.filter(({ k }) => k.split("+").includes("alt") && k.split("+").includes("cmd"))).toEqual([]);
    }
  });
  test("Move Chat Left / Right: ⌥⌘← → on the Mac, Ctrl Shift [ ] on Windows and Linux, each matching only on its own system", () => {
    const left = KEYMAP.find((b) => b.id === "chat.left")!;
    const right = KEYMAP.find((b) => b.id === "chat.right")!;
    expect(keysOf(left, "macos")).toEqual(["cmd+left", "alt+cmd+left"]);
    for (const os of PC) {
      expect(keysOf(left, os)).toEqual(["cmd+left", "cmd+shift+["]);
      expect(keysOf(right, os)).toEqual(["cmd+right", "cmd+shift+]"]);
    }
    // in the message box, where the plain chord is the caret's
    expect(resolve(ev("{", { ctrl: true, shift: true }, true), "desk", "windows")?.id).toBe("chat.left");
    expect(resolve(ev("}", { ctrl: true, shift: true }, true), "desk", "linux")?.id).toBe("chat.right");
    expect(resolve(ev("[", { ctrl: true, shift: true }, true), "desk", "linux")?.id).toBe("chat.left"); // a layout that reports the unshifted key
    expect(resolve(ev("ArrowLeft", { ctrl: true, alt: true }, true), "desk", "windows")).toBeNull();
    expect(resolve(ev("ArrowLeft", { ctrl: true, alt: true }, true), "desk", "linux")).toBeNull();
    expect(resolve(ev("ArrowLeft", { ctrl: true }, true), "desk", "windows")).toBeNull(); // the caret's word jump
    expect(resolve(ev("ArrowLeft", { ctrl: true }), "desk", "windows")?.id).toBe("chat.left");
    // the Mac keeps its own and does not take the new one
    expect(resolve(ev("ArrowLeft", { meta: true, alt: true }, true), "desk", "macos")?.id).toBe("chat.left");
    expect(resolve(ev("{", { meta: true, shift: true }, true), "desk", "macos")).toBeNull();
    // the shifted bracket is nothing else's, and ⌘[ still wants no Shift
    expect(chordIds(ev("{", { ctrl: true, shift: true }), KEYMAP, "windows")).toEqual(["chat.left"]);
    expect(resolve(ev("[", { ctrl: true }), "desk", "windows")?.id).toBe("desk.prev");
    // listed under the new key: the keys sheet and Preferences › keys
    const rows = keysFor("desk", KEYMAP, "windows").find((g) => g.where === "desk")!.rows;
    expect(rows.find((b) => b.id === "chat.left")!.keys.map((k) => formatKeys(k, "windows"))).toEqual(["Ctrl ←", "Ctrl Shift ["]);
    expect(keyRows("linux").find((b) => b.id === "chat.right")!.keys).toEqual(["cmd+right", "cmd+shift+]"]);
    expect(keyRows("macos").find((b) => b.id === "chat.right")!.keys).toEqual(["cmd+right", "alt+cmd+right"]);
  });
  test("the system-wide key is the Mac's alone: none on Windows or Linux, and Preferences › keys leaves it out there", () => {
    const g = KEYMAP.find((b) => b.id === "global.inbox")!;
    expect(keysOf(g, "macos")).toEqual(["alt+space"]);
    for (const os of PC) {
      expect(keysOf(g, os)).toEqual([]);
      expect(keyRows(os).map((b) => b.id)).not.toContain("global.inbox");
    }
    expect(keyRows("macos").map((b) => b.id)).toContain("global.inbox");
    // the table's order is WHERE_ORDER's, the same on every system
    expect(keyRows("windows").map((b) => b.id)).toEqual(keyRows("macos").map((b) => b.id).filter((id) => id !== "global.inbox"));
  });
  test("conflicts() and takenBy() read each system's keys", () => {
    for (const os of ["macos", "windows", "linux"] as const) expect(conflicts(KEYMAP, os)).toEqual([]);
    const planted: Binding[] = [
      { id: "a", keys: ["cmd+1"], where: "desk", label: "A" },
      { id: "b", keys: ["cmd+2"], keysOn: { windows: ["cmd+1"] }, where: "desk", label: "B" },
    ];
    expect(conflicts(planted, "macos")).toEqual([]);
    expect(conflicts(planted, "windows")).toEqual(["cmd+1 in desk: a and b"]);
    expect(conflicts(planted)).toEqual(["cmd+1 in desk: a and b (windows)"]);
    const everywhere: Binding = { id: "e", keys: ["cmd+9"], keysOn: { linux: ["cmd+1"] }, where: "anywhere", label: "E" };
    expect(takenBy(everywhere, [...planted, everywhere], "macos")).toEqual([]);
    expect(takenBy(everywhere, [...planted, everywhere], "linux")).toEqual([{ where: "desk", key: "cmd+1", id: "a", label: "A" }]);
    // the one real case reads the same everywhere
    const toggle = KEYMAP.find((b) => b.id === "column.toggle")!;
    for (const os of PC) expect(takenBy(toggle, KEYMAP, os)).toEqual([{ where: "inbox", key: "cmd+shift+d", id: "inbox.deny", label: "Deny" }]);
  });
  test("the menu's accelerators follow the system's keys", () => {
    const moved: Binding[] = [{ id: "x", keys: ["alt+cmd+j"], keysOn: { windows: ["cmd+j"] }, where: "anywhere", label: "X", menu: "Desk" }];
    const accel = (os: Platform) => (menuSpec(moved, os)[0].items[0] as { accelerator: string | null }).accelerator;
    expect(accel("macos")).toBe("Alt+CmdOrCtrl+J");
    expect(accel("windows")).toBe("CmdOrCtrl+J");
    expect(accel("linux")).toBe("Alt+CmdOrCtrl+J");
  });
  test("keyFor reads a binding's key by id on each system; a second key by index; an unknown id is a mistake", () => {
    expect(keyFor("inbox.approve", "macos")).toBe("⌘↵");
    expect(keyFor("inbox.approve", "windows")).toBe("Ctrl Enter");
    expect(keyFor("inbox.approve", "linux", 1)).toBe("A");
    expect(keyFor("desk.done", "macos")).toBe("⌘⇧↵");
    expect(keyFor("segment.settings", "windows")).toBe("Ctrl 6");
    expect(keyFor("segment.settings", "windows", 1)).toBe("Ctrl ,");
    expect(() => keyFor("no.such")).toThrow();
    expect(() => keyFor("global.inbox", "windows")).toThrow(); // no key there
  });
  test("a was line names the key it points to on each system", () => {
    const search = KEYMAP.find((b) => b.id === "search.open")!;
    expect(wasFor(search, "windows")).toBe("was the desks tree: desks are in the sidebar now (Ctrl Shift D shows or hides it)");
    expect(wasFor(KEYMAP.find((b) => b.id === "desk.new")!, "windows")).toBeUndefined();
  });
  test("⌘ held means ⌘ alone on the Mac (Ctrl+D deletes forward in a Mac text box) and Ctrl alone elsewhere", () => {
    expect(cmdHeld(ev("d", { meta: true }), "macos")).toBe(true);
    expect(cmdHeld(ev("d", { ctrl: true }), "macos")).toBe(false);
    expect(cmdHeld(ev("d", { ctrl: true }), "windows")).toBe(true);
    expect(cmdHeld(ev("d", { ctrl: true }), "linux")).toBe(true);
    expect(cmdHeld(ev("d", { meta: true }), "windows")).toBe(false);
    expect(cmdHeld(ev("d", { meta: true, ctrl: true }), "linux")).toBe(false);
    expect(cmdHeld(ev("d"), "macos")).toBe(false);
  });
  test("the (⌘K) on the search command comes from the keymap; core's text names no key", () => {
    const desks = LOKI_COMMANDS.find((c) => c.id === "desks")!;
    expect(desks.description).not.toMatch(MAC_KEYS);
    expect(commandText(desks, "macos")).toBe("search desks, agents and pages (⌘K)");
    expect(commandText(desks, "windows")).toBe("search desks, agents and pages (Ctrl K)");
    // the others read as before: no key appended
    for (const c of LOKI_COMMANDS.filter((c) => c.id !== "desks")) expect(commandText(c, "windows")).toBe(c.description);
  });
});

describe("the page's system (plan 014 U2, KTD1)", () => {
  const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
  const WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
  const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)";
  test("the shell's word wins; a browser tab reads its user agent", () => {
    expect(platformFrom(undefined, MAC)).toBe("macos");
    expect(platformFrom("windows", MAC)).toBe("windows");
    expect(platformFrom("linux", MAC)).toBe("linux");
    expect(platformFrom("macos", WIN)).toBe("macos");
    expect(platformFrom(undefined, WIN)).toBe("windows");
    expect(platformFrom(undefined, LINUX)).toBe("linux");
  });
  test("anything unknown is the Mac, loki's home: an odd word from the shell, a phone, a test runner", () => {
    expect(platformFrom("beos", WIN)).toBe("windows"); // an unknown word falls through to the user agent
    expect(platformFrom(undefined, "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("macos");
    expect(platformFrom(undefined, "Bun/1.2.0")).toBe("macos");
    expect(platformFrom(undefined, "")).toBe("macos");
  });
});
