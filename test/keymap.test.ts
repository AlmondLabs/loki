import { describe, expect, test } from "bun:test";
import { KEYMAP, conflicts, formatKeys, matches, menuSpec, resolve, tauriAccelerator, chordIds, dialogState, keySegment, shellKeyAllowed } from "../app/src/shell/keymap.ts";

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
    expect(chordIds(ev("k", { meta: true }))).toEqual(["tree.toggle"]);
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
    for (const id of ["desk.new", "task.new", "keys.sheet", "column.toggle", "tree.toggle", "desk.next", "chat.focus"]) {
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
