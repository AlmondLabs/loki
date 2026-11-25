import type { MenuItemConstructorOptions, NativeImage } from "electron";
import { describe, expect, test } from "vitest";
import { keysToAccelerator, menuBarTemplate, popupTemplate, type PopupEntry } from "../desktop/menus.ts";

const fakeImage = (png: number[]) => ({ png }) as unknown as NativeImage;
const submenuOf = (item: MenuItemConstructorOptions | undefined): MenuItemConstructorOptions[] => (Array.isArray(item?.submenu) ? item.submenu : []);

describe("the Mac menu bar", () => {
  test("the page's own loki items join the app menu, its other menus sit between Edit and Window, and a click sends the id", () => {
    const sent: string[] = [];
    const bar = menuBarTemplate(
      [
        { title: "loki", items: [{ id: "settings", label: "Settings…", accelerator: "CommandOrControl+," }] },
        { title: "Chat", items: [{ id: "new", label: "New Chat", accelerator: "CommandOrControl+N" }, { separator: true }, { id: "x" }] },
      ],
      (id) => sent.push(id),
    );
    expect(bar.map((m) => m.label)).toEqual(["loki", "Edit", "Chat", "Window"]);
    const app = submenuOf(bar[0]);
    expect(app[0]).toMatchObject({ role: "about", label: "About loki" });
    expect(app.find((i) => i.id === "settings")).toMatchObject({ label: "Settings…", accelerator: "CommandOrControl+," });
    expect(app.at(-1)).toMatchObject({ role: "quit" });
    const chat = submenuOf(bar[2]);
    expect(chat.map((i) => i.type ?? i.id)).toEqual(["new", "separator"]);
    chat[0]?.click?.(undefined as never, undefined, undefined as never);
    expect(sent).toEqual(["new"]);
  });
});

describe("pop-up menus", () => {
  test("an item answers with its index, depth first, separators and submenus not counted", () => {
    const chosen: number[] = [];
    const entries: PopupEntry[] = [
      { type: "item", label: "Open", enabled: true },
      { type: "separator" },
      {
        type: "submenu",
        label: "Move To",
        enabled: true,
        items: [
          { type: "item", label: "Inbox", enabled: true },
          { type: "item", label: "Archive", enabled: false },
        ],
      },
    ];
    const menu = popupTemplate(entries, (i) => chosen.push(i), fakeImage);
    submenuOf(menu[2])[1]?.click?.(undefined as never, undefined, undefined as never);
    menu[0]?.click?.(undefined as never, undefined, undefined as never);
    expect(chosen).toEqual([2, 0]);
    expect(submenuOf(menu[2])[1]).toMatchObject({ enabled: false });
  });

  test("a choice shows its tick, its keys on the right without taking them, and its icon", () => {
    const [item] = popupTemplate([{ type: "item", label: "Pin", enabled: true, checked: true, keys: "cmd+shift+p", icon: [1, 2] }], () => {}, fakeImage);
    expect(item).toMatchObject({ type: "checkbox", checked: true, accelerator: "CommandOrControl+Shift+P", registerAccelerator: false, icon: { png: [1, 2] } });
  });

  test("the keymap's keys become Electron's accelerators", () => {
    expect(keysToAccelerator("cmd+]")).toBe("CommandOrControl+]");
    expect(keysToAccelerator("alt+space")).toBe("Alt+Space");
    expect(keysToAccelerator("ctrl+enter")).toBe("Control+Enter");
    expect(keysToAccelerator("cmd++")).toBe("CommandOrControl+Plus");
    expect(keysToAccelerator("hyper+k")).toBeNull();
  });
});
