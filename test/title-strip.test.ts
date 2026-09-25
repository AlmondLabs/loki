import { describe, expect, test } from "bun:test";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TitleStrip, WindowControls, titlebarHeight } from "../app/src/shell/Sidebar.tsx";
import { TitleMenuPanel, titleMenus, runMenuItem } from "../app/src/shell/TitleMenu.tsx";
import { KEYMAP, labelOf, menuSpec, registerActions, resolve } from "../app/src/shell/keymap.ts";
import { guardBrowserKey } from "../app/src/shell/useShellKeys.ts";
import { LAYER } from "../app/src/kit/layers.ts";
import type { Platform } from "../app/src/desk/env.ts";

const strip = (os: Platform, shell = true) => renderToStaticMarkup(createElement(TitleStrip, { os, shell }));

/** Every element in a rendered-to-elements tree (props.children followed), for finding a handler without a DOM. */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  return [el, ...elements(el.props.children as ReactNode)];
}

const key = (k: string, mods: Partial<{ meta: boolean; ctrl: boolean; shift: boolean; alt: boolean }> = {}, typing = false) => {
  const e = { key: k, metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, target: typing ? { tagName: "TEXTAREA" } : { tagName: "DIV" }, prevented: false, preventDefault() { this.prevented = true; } };
  return e as unknown as KeyboardEvent & { prevented: boolean };
};

describe("the title strip (plan 014 U4, KTD4)", () => {
  test("the Mac's strip is the bare drag region it always was: no buttons, the lights are the system's", () => {
    expect(strip("macos")).toBe(`<div data-tauri-drag-region="true" aria-hidden="true" class="loki-title-strip" style="height:28px;z-index:${LAYER.rail}"></div>`);
    expect(titlebarHeight(true, "macos")).toBe(28);
  });

  test("a browser tab has no strip on any system", () => {
    for (const os of ["macos", "windows", "linux"] as const) {
      expect(strip(os, false)).toBe("");
      expect(titlebarHeight(false, os)).toBe(0);
    }
  });

  test("Windows and Linux: ☰ on the left, then minimise, maximise and close with their names, and the strip still drags", () => {
    for (const os of ["windows", "linux"] as const) {
      const out = strip(os);
      expect(out).toContain("data-tauri-drag-region");
      expect(out).not.toContain('aria-hidden="true" class="loki-title-strip"');
      const labels = [...out.matchAll(/<button[^>]*aria-label="([^"]+)"/g)].map((m) => m[1]);
      expect(labels).toEqual(["Menu", "Minimise", "Maximise", "Close"]);
      expect(out).toContain('aria-haspopup="menu"');
      expect(out).toContain(`height:${titlebarHeight(true, os)}px`);
    }
  });

  test("the maximise button reads Restore while the window is maximised", () => {
    const html = (maximized: boolean) => renderToStaticMarkup(createElement(WindowControls, { maximized, onAction: () => {} }));
    expect(html(false)).toContain('aria-label="Maximise"');
    expect(html(true)).toContain('aria-label="Restore"');
    expect(html(true)).not.toContain('aria-label="Maximise"');
  });

  test("the window buttons ask for their actions", () => {
    const asked: string[] = [];
    const tree = WindowControls({ maximized: false, onAction: (a) => asked.push(a) });
    for (const el of elements(tree)) if (typeof el.props.onClick === "function") (el.props.onClick as () => void)();
    expect(asked).toEqual(["minimize", "toggleMaximize", "close"]);
  });
});

describe("the ☰ menu (plan 014 U4, KTD4)", () => {
  test("it lists every menu the Mac's menu bar shows, in order, then Hide loki", () => {
    for (const os of ["windows", "linux"] as const) {
      const groups = titleMenus(os);
      expect(groups.map((g) => g.title)).toEqual(menuSpec(undefined, os).map((m) => m.title));
      const out = renderToStaticMarkup(createElement(TitleMenuPanel, { groups, open: null, onOpen: () => {}, onPick: () => {}, os }));
      for (const g of groups) expect(out).toContain(`>${g.title}<`);
      expect(out).toContain(labelOf(KEYMAP.find((b) => b.id === "window.hide")!, os));
      expect(out).toContain("Ctrl Shift W");
    }
  });

  test("each menu's items carry Ctrl keys, never the Mac's symbols, where the Mac's menu shows an accelerator", () => {
    for (const os of ["windows", "linux"] as const) {
      const groups = titleMenus(os);
      const spec = menuSpec(undefined, os);
      for (const g of groups) {
        const out = renderToStaticMarkup(createElement(TitleMenuPanel, { groups, open: g.title, onOpen: () => {}, onPick: () => {}, os }));
        expect(out).not.toMatch(/[⌘⇧⌥]/);
        const mac = spec.find((m) => m.title === g.title)!;
        for (const it of mac.items) {
          if ("separator" in it) continue;
          expect(out).toContain(it.label.replace(/&/g, "&amp;"));
          const mine = g.items.find((x) => !("separator" in x) && x.id === it.id);
          expect(mine && !("separator" in mine) && mine.keys !== null).toBe(it.accelerator !== null);
        }
      }
      const desk = groups.find((g) => g.title === "Desk")!;
      expect(desk.items).toContainEqual({ id: "search.open", label: "Search", keys: "Ctrl K" });
    }
  });

  test("choosing an item runs its action, the way a Mac menu click does", () => {
    const ran: string[] = [];
    const off = registerActions({ "desk.new": () => ran.push("desk.new"), "window.hide": () => ran.push("window.hide") });
    try {
      const groups = titleMenus("windows");
      const picked: string[] = [];
      const tree = TitleMenuPanel({ groups, os: "windows", open: "Desk", onOpen: () => {}, onPick: (id) => (picked.push(id), runMenuItem(id)) });
      const click = (id: string) => (elements(tree).find((el) => el.props["data-menu-id"] === id)!.props.onClick as () => void)();
      click("desk.new");
      click("window.hide");
      expect(picked).toEqual(["desk.new", "window.hide"]);
      expect(ran).toEqual(["desk.new", "window.hide"]);
    } finally {
      off();
    }
  });

  test("a menu title opens its menu", () => {
    const opened: Array<string | null> = [];
    const tree = TitleMenuPanel({ groups: titleMenus("linux"), os: "linux", open: null, onOpen: (t) => opened.push(t), onPick: () => {} });
    (elements(tree).find((el) => el.props["data-menu"] === "Board")!.props.onClick as () => void)();
    expect(opened).toEqual(["Board"]);
  });
});

describe("the webview's own browser keys off the Mac (plan 014 U4)", () => {
  test("Ctrl+R never reaches the webview as a reload in the app: the board's refresh is loki's, everywhere else it is ignored", () => {
    for (const os of ["windows", "linux"] as const) {
      const e = key("r", { ctrl: true });
      guardBrowserKey(e, os, true);
      expect(e.prevented).toBe(true);
      expect(resolve(key("r", { ctrl: true }), "board", os)?.id).toBe("board.refresh");
      expect(resolve(key("r", { ctrl: true }), "inbox", os)).toBeNull();
    }
  });

  test("reload, print, find, devtools and view source are held back; Ctrl+F still resolves to loki's find", () => {
    const held: Array<[string, Partial<{ ctrl: boolean; shift: boolean; alt: boolean }>]> = [
      ["F5", {}],
      ["F5", { ctrl: true }],
      ["R", { ctrl: true, shift: true }],
      ["p", { ctrl: true }],
      ["f", { ctrl: true }],
      ["g", { ctrl: true }],
      ["G", { ctrl: true, shift: true }],
      ["F3", {}],
      ["u", { ctrl: true }],
      ["I", { ctrl: true, shift: true }],
      ["J", { ctrl: true, shift: true }],
      ["C", { ctrl: true, shift: true }],
      ["F12", {}],
      ["F7", {}],
      ["ArrowLeft", { alt: true }],
    ];
    for (const [k, mods] of held) {
      const e = key(k, mods);
      guardBrowserKey(e, "windows", true);
      expect([k, mods, e.prevented]).toEqual([k, mods, true]);
    }
    expect(resolve(key("f", { ctrl: true }), "desk", "windows")?.id).toBe("chat.find");
  });

  test("the text's own keys, the Mac, a browser tab and a development build are left alone", () => {
    for (const [k, mods] of [["c", { ctrl: true }], ["v", { ctrl: true }], ["a", { ctrl: true }], ["r", {}], ["i", { ctrl: true }]] as const) {
      const e = key(k, mods, true);
      guardBrowserKey(e, "windows", true);
      expect([k, e.prevented]).toEqual([k, false]);
    }
    const mac = key("r", { meta: true });
    guardBrowserKey(mac, "macos", true);
    expect(mac.prevented).toBe(false);
    const dev = key("r", { ctrl: true });
    guardBrowserKey(dev, "windows", false);
    expect(dev.prevented).toBe(false);
  });
});
