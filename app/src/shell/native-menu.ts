import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { LucideIcon } from "lucide-react";
import { inTauri, platform } from "../desk/env";

/**
 * A menu described once (plan 2026-11-12-1505, U19): in the Mac app it pops up as a real macOS menu at the control or the
 * pointer, drawn by AppKit (U22); everywhere else the same entries draw as loki's own menu.
 * Either way an action shows the same Lucide icon it has in the rest of the app.
 */
export type MenuEntry =
  | {
      type: "item";
      /** Unique within the menu. */
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
      /**
       * The action's icon, the one it has in the toolbar and elsewhere (one icon set, Lucide), as Tahoe's menus put one
       * on an action; never on a choice in a picker.
       */
      icon?: LucideIcon;
    }
  | { type: "separator" }
  | { type: "submenu"; id: string; label: string; items: MenuEntry[]; disabled?: boolean };

/** Whether this window pops up native menus: the Mac app only. */
export const NATIVE_MENUS = inTauri && platform === "macos";

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

/** One entry as the shell takes it (src-tauri popup.rs `PopupEntry`). */
export type PopupEntry =
  | { type: "item"; label: string; enabled: boolean; checked?: boolean; keys?: string; icon?: number[] }
  | { type: "separator" }
  | { type: "submenu"; label: string; enabled: boolean; items: PopupEntry[] };

/**
 * The entries as the shell takes them, and each item's action by its index: the shell answers with the index of the
 * item chosen, counted depth first over items alone, as `popup.rs` tags them. `iconPng` gives an icon's picture, made
 * beforehand (`iconImage`); without one the item shows none.
 */
export function popupEntries(
  entries: MenuEntry[],
  iconPng: (icon: LucideIcon) => number[] | undefined = () => undefined,
): { entries: PopupEntry[]; runs: Array<() => void> } {
  const runs: Array<() => void> = [];
  const shape = (list: MenuEntry[]): PopupEntry[] =>
    tidyEntries(list).map((e): PopupEntry => {
      if (e.type === "separator") return { type: "separator" };
      if (e.type === "submenu") return { type: "submenu", label: e.label, enabled: !e.disabled, items: shape(e.items) };
      runs.push(e.run);
      return {
        type: "item",
        label: e.detail ? `${e.label} (${e.detail})` : e.label,
        enabled: !e.disabled,
        ...(e.checked !== undefined ? { checked: e.checked } : {}),
        ...(e.keys ? { keys: e.keys } : {}),
        ...(e.icon && iconPng(e.icon) ? { icon: iconPng(e.icon) } : {}),
      };
    });
  return { entries: shape(entries), runs };
}

/**
 * Pop the entries up as a native menu at `at` (window coordinates, in CSS pixels): under the control that opened
 * it, or at the pointer for a right-click. The shell draws it in AppKit (popup.rs) and answers once it closes; the
 * item chosen, if any, then runs. Resolves after that.
 */
export async function popUpMenu(entries: MenuEntry[], at: { x: number; y: number }): Promise<void> {
  const icons = [...new Set(iconsOf(tidyEntries(entries)))];
  const pngs = new Map(await Promise.all(icons.map(async (icon) => [icon, await iconImage(icon).catch(() => undefined)] as const)));
  const menu = popupEntries(entries, (icon) => pngs.get(icon));
  if (!menu.entries.length) return;
  const { invoke } = await import("@tauri-apps/api/core");
  const chosen = await invoke<number | null>("popup_menu", { entries: menu.entries, x: Math.round(at.x), y: Math.round(at.y) });
  if (chosen !== null) menu.runs[chosen]?.();
}

/** Every icon a menu's items carry, submenus included. */
function iconsOf(entries: MenuEntry[]): LucideIcon[] {
  return entries.flatMap((e) => (e.type === "item" ? (e.icon ? [e.icon] : []) : e.type === "submenu" ? iconsOf(e.items) : []));
}

/** The icons drawn so far, by icon: a menu opens again and again with the same few. */
const drawn = new Map<LucideIcon, Promise<number[]>>();

/**
 * An icon as the native menu shows it: drawn in the page at 16 points on a 2x canvas, at the stroke the toolbar uses,
 * as PNG bytes. The shell marks it a template image, so AppKit colours it as the item's text, plain or highlighted, in
 * light and dark; only its shape is read.
 */
export function iconImage(icon: LucideIcon): Promise<number[]> {
  const known = drawn.get(icon);
  if (known) return known;
  const made = drawIcon(icon);
  drawn.set(icon, made);
  // A drawing that failed is tried again on the next menu, not remembered.
  made.catch(() => drawn.delete(icon));
  return made;
}

const ICON_PX = 32;

async function drawIcon(icon: LucideIcon): Promise<number[]> {
  const host = document.createElement("div");
  const root = createRoot(host);
  // No colour given: an SVG drawn as an image draws its currentColor black, and the template reads only the shape.
  flushSync(() => root.render(createElement(icon, { size: ICON_PX, strokeWidth: 1.75, "aria-hidden": true })));
  const svg = host.innerHTML;
  root.unmount();
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image(ICON_PX, ICON_PX);
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = ICON_PX;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas to draw the menu's icon on");
    ctx.drawImage(img, 0, 0, ICON_PX, ICON_PX);
    const png = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/png"));
    if (!png) throw new Error("the menu's icon could not be made a picture");
    return Array.from(new Uint8Array(await png.arrayBuffer()));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Where a menu opened from a control hangs: its leading edge, just under it (above it with `above`). */
export function under(el: Element, above = false): { x: number; y: number } {
  const box = el.getBoundingClientRect();
  return { x: box.left, y: above ? box.top - 4 : box.bottom + 4 };
}
