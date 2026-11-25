import type { MenuItemConstructorOptions, NativeImage } from "electron";

/** The Mac menu bar as the page sends it with `set_menu`: each menu's title and items; an item's click is sent back as `loki:menu` with its id. */
export interface MenuSpec {
  title: string;
  items: Array<{ id?: string; label?: string; accelerator?: string; separator?: boolean }>;
}

/**
 * A pop-up menu as the page sends it with `popup_menu`. Chosen, an item answers with its index among the menu's items,
 * depth first, separators and submenus not counted; `keys` is the keymap's form ("cmd+shift+m"); `icon` is PNG bytes
 * drawn at 2x for 16 points, used as a template image.
 */
export type PopupEntry =
  | { type: "item"; label: string; enabled: boolean; checked?: boolean; keys?: string; icon?: number[] }
  | { type: "separator" }
  | { type: "submenu"; label: string; enabled: boolean; items: PopupEntry[] };

const APP_MENU = "loki";

const KEY_NAMES: Record<string, string> = {
  enter: "Enter",
  tab: "Tab",
  space: "Space",
  escape: "Escape",
  backspace: "Backspace",
  delete: "Delete",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
};

export function keysToAccelerator(keys: string): string | null {
  const parts = keys.split("+").filter((p) => p !== "");
  const key = keys.endsWith("+") ? "Plus" : parts.pop();
  if (!key) return null;
  const mods = parts.map((m) => ({ cmd: "CommandOrControl", shift: "Shift", alt: "Alt", ctrl: "Control" })[m]);
  if (mods.some((m) => m === undefined)) return null;
  const name = key === "Plus" ? key : (KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : null));
  return name ? [...mods, name].join("+") : null;
}

function specItems(items: MenuSpec["items"], emit: (id: string) => void): MenuItemConstructorOptions[] {
  return items.flatMap((it): MenuItemConstructorOptions[] => {
    if (it.separator) return [{ type: "separator" }];
    const { id, label } = it;
    if (!id || !label) return [];
    return [{ id, label, ...(it.accelerator ? { accelerator: it.accelerator } : {}), click: () => emit(id) }];
  });
}

export function menuBarTemplate(menus: MenuSpec[], emit: (id: string) => void): MenuItemConstructorOptions[] {
  const own = menus.filter((m) => m.title === APP_MENU).flatMap((m) => specItems(m.items, emit));
  const rest = menus.filter((m) => m.title !== APP_MENU);
  return [
    {
      label: APP_MENU,
      submenu: [
        { role: "about", label: "About loki" },
        { type: "separator" },
        ...own,
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }],
    },
    ...rest.map((m): MenuItemConstructorOptions => ({ label: m.title, submenu: specItems(m.items, emit) })),
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "close" }] },
  ];
}

export function popupTemplate(entries: PopupEntry[], choose: (index: number) => void, image: (png: number[]) => NativeImage): MenuItemConstructorOptions[] {
  let next = 0;
  const build = (list: PopupEntry[]): MenuItemConstructorOptions[] =>
    list.map((e): MenuItemConstructorOptions => {
      if (e.type === "separator") return { type: "separator" };
      if (e.type === "submenu") return { label: e.label, enabled: e.enabled, submenu: build(e.items) };
      const index = next++;
      const accelerator = e.keys ? keysToAccelerator(e.keys) : null;
      return {
        label: e.label,
        enabled: e.enabled,
        ...(e.checked !== undefined ? { type: "checkbox", checked: e.checked } : {}),
        ...(accelerator ? { accelerator, registerAccelerator: false } : {}),
        ...(e.icon ? { icon: image(e.icon) } : {}),
        click: () => choose(index),
      };
    });
  return build(entries);
}
