import type { CheckMenuItemOptions, MenuItemOptions, PredefinedMenuItemOptions, SubmenuOptions } from "@tauri-apps/api/menu";
import { inTauri, platform } from "../desk/env";
import { useLook } from "../theme";
import { tauriAccelerator } from "./keymap";

/**
 * A menu described once (plan 2026-11-12-1505, U19): under Liquid Glass in the Mac app it pops up as a real macOS
 * menu at the control or the pointer; everywhere else the same entries draw as loki's own menu.
 */
export type MenuEntry =
  | {
      type: "item";
      /** Unique within the menu; it never reaches the menu bar's actions (see POPUP). */
      id: string;
      label: string;
      run: () => void;
      disabled?: boolean;
      /** A choice: a checkmark when true, room for one when false; absent for a command. */
      checked?: boolean;
      /** A quiet count after the label: muted on the right when drawn, in brackets in a native menu. */
      detail?: string;
      /** The keymap's key spec ("cmd+e"), shown on the right as the Mac shows a shortcut. */
      keys?: string | null;
      /** Why the item is off, as the drawn menu's tooltip (a native menu has none). */
      hint?: string;
    }
  | { type: "separator" }
  | { type: "submenu"; id: string; label: string; items: MenuEntry[]; disabled?: boolean };

/** Whether this window can pop up native menus: the Mac app only. */
export const NATIVE_MENUS = inTauri && platform === "macos";

/** Whether menus pop up natively here: Liquid Glass in the Mac app (today's look keeps loki's own menus). */
export function useNativeMenus(): boolean {
  return useLook() === "glass" && NATIVE_MENUS;
}

/**
 * The prefix on every popped-up item's id. The shell sends every native menu click on as `loki:menu`
 * (src-tauri menu.rs); the page skips these, since the item's own action already ran.
 */
export const POPUP = "popup:";

/** Separators only between groups: none leading, trailing or doubled, which an item left out can leave behind. */
export function tidyEntries(entries: MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const e of entries) {
    if (e.type === "separator" && (out.length === 0 || out.at(-1)?.type === "separator")) continue;
    if (e.type === "submenu") {
      const items = tidyEntries(e.items);
      if (items.length) out.push({ ...e, items });
      continue;
    }
    out.push(e);
  }
  while (out.at(-1)?.type === "separator") out.pop();
  return out;
}

/** One entry as Tauri's menu API takes it: plain options it turns into items, check items, separators and submenus. */
type NativeOption = MenuItemOptions | CheckMenuItemOptions | SubmenuOptions | PredefinedMenuItemOptions;

/** The entries in Tauri's option shape, every id carrying POPUP so a click is never taken for a menu-bar binding. */
export function nativeOptions(entries: MenuEntry[]): NativeOption[] {
  return tidyEntries(entries).map((e): NativeOption => {
    if (e.type === "separator") return { item: "Separator" };
    if (e.type === "submenu") return { id: POPUP + e.id, text: e.label, enabled: !e.disabled, items: nativeOptions(e.items) };
    return {
      id: POPUP + e.id,
      text: e.detail ? `${e.label} (${e.detail})` : e.label,
      enabled: !e.disabled,
      ...(e.keys ? { accelerator: tauriAccelerator(e.keys) } : {}),
      ...(e.checked !== undefined ? { checked: e.checked } : {}),
      action: e.run,
    };
  });
}

/** The last menu popped up: freed when the next one opens (a menu is modal, so by then it is long closed). */
let last: { close: () => Promise<void> } | null = null;

/**
 * Pop the entries up as a native menu at `at` (window coordinates, in CSS pixels): under the control that opened
 * it, or at the pointer for a right-click. Resolves once the menu is up (or closed, as macOS tracks it).
 */
export async function popUpMenu(entries: MenuEntry[], at: { x: number; y: number }): Promise<void> {
  const items = nativeOptions(entries);
  if (!items.length) return;
  const [{ Menu }, { LogicalPosition }] = await Promise.all([import("@tauri-apps/api/menu"), import("@tauri-apps/api/dpi")]);
  const prev = last;
  last = null;
  void prev?.close().catch(() => {});
  const menu = await Menu.new({ items });
  last = menu;
  await menu.popup(new LogicalPosition(Math.round(at.x), Math.round(at.y)));
}

/** Where a menu opened from a control hangs: its leading edge, just under it (above it with `above`). */
export function under(el: Element, above = false): { x: number; y: number } {
  const box = el.getBoundingClientRect();
  return { x: box.left, y: above ? box.top - 4 : box.bottom + 4 };
}
