import { useRef, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { cx } from "../components/parts";
import { keyboard, type Platform } from "../desk/env";
import { lastInput } from "../kit/motion";
import { KEYMAP, formatKeys, keyFor, keysOf, labelOf, menuSpec, runAction, type Binding } from "./keymap";
import { MenuIcon } from "lucide-react";
import { Glyph } from "../shared/icons";

/** A line of a ☰ menu: a keymap id, its label and its key as this system reads it (null where the Mac's menu shows none). */
export interface TitleMenuEntry {
  id: string;
  label: string;
  keys: string | null;
}
/** One ☰ menu: its title and its lines, with separators between groups. */
export interface TitleMenuGroup {
  title: string;
  items: Array<TitleMenuEntry | { separator: true }>;
}

const HIDE = "window.hide";
/** Hide's line in the keymap, which every build has. */
const HIDE_BINDING: Binding = (() => {
  const b = KEYMAP.find((x) => x.id === HIDE);
  if (!b) throw new Error(`the keymap has no ${HIDE}`);
  return b;
})();

/**
 * The Mac's menu bar as ☰ shows it on Windows and Linux (plan 014 KTD4): the same menuSpec groups, in order, their keys
 * in Ctrl words. An item without an accelerator on the Mac shows none here either.
 */
export function titleMenus(os: Platform = keyboard, map: Binding[] = KEYMAP, labels: Record<string, string> = {}): TitleMenuGroup[] {
  return menuSpec(map, os, labels).map((m) => ({
    title: m.title,
    items: m.items.map((it) => {
      if ("separator" in it) return it;
      const b = map.find((x) => x.id === it.id);
      const k = b && it.accelerator ? keysOf(b, os)[0] : undefined;
      return { id: it.id, label: it.label, keys: k ? formatKeys(k, os) : null };
    }),
  }));
}

/** A ☰ pick: the action the Mac's menu click runs (useShellKeys, loki:menu), straight through the registry. */
export function runMenuItem(id: string): void {
  if (!runAction(id)) console.warn("loki: menu item without an action", id);
}

/** An item's look in the ☰ menu and its submenus: the label at the left, the key at the right. */
const ITEM = "justify-between gap-3";

/**
 * The menu's items, without its root (plan 2026-11-15-1930, KTD1): each title a submenu of Base UI's, holding that
 * menu's items and separators with their keys, then Hide loki (Minimise loki there, labelOf). Base UI opens a title on
 * hover, →, Return or Space, closes it on ← or Esc, and moves with ↑↓ Home End and type-ahead.
 */
export function TitleMenuItems({ groups, onPick, os = keyboard }: { groups: TitleMenuGroup[]; onPick: (id: string) => void; os?: Platform }) {
  return (
    <>
      {groups.map((g) => (
        <DropdownMenuSub key={g.title}>
          <DropdownMenuSubTrigger data-menu={g.title}>{g.title}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent aria-label={g.title} className="loki-popover" style={{ minWidth: 260 }}>
            {g.items.map((it, i) =>
              "separator" in it ? (
                <DropdownMenuSeparator key={`sep-${i}`} />
              ) : (
                <DropdownMenuItem key={it.id} data-menu-id={it.id} className={ITEM} onClick={() => onPick(it.id)}>
                  <span>{it.label}</span>
                  {it.keys && <DropdownMenuShortcut>{it.keys}</DropdownMenuShortcut>}
                </DropdownMenuItem>
              ),
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuItem data-menu-id={HIDE} className={ITEM} onClick={() => onPick(HIDE)}>
        <span>{labelOf(HIDE_BINDING, os)}</span>
        <DropdownMenuShortcut>{keyFor(HIDE, os)}</DropdownMenuShortcut>
      </DropdownMenuItem>
    </>
  );
}

/**
 * ☰ and its menu, at the strip's left end on Windows and Linux and beside the sidebar toggle in a browser tab, its
 * items named by `labels` where their words change (the update item). It is shadcn's DropdownMenu on Base UI, as every
 * other menu loki draws (plan 2026-11-15-1930, KTD1): Esc, Tab, a press outside or a pick close it, and focus goes back
 * to ☰ unless the pick took it elsewhere. Opened by a click it grows from ☰; opened by a key it is simply there.
 */
export function TitleMenu({ os = keyboard, labels = {}, className }: { os?: Platform; labels?: Record<string, string>; className?: string }) {
  const [open, setOpen] = useState(false);
  const popup = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const grows = open && lastInput() === "pointer";
  return (
    <span className={className ? `loki-title-menu-anchor ${className}` : "loki-title-menu-anchor"}>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          ref={trigger}
          render={
            <button type="button" className="loki-title-btn loki-title-btn--menu" aria-label="Menu" title="Menu">
              <Glyph icon={MenuIcon} size={16} />
            </button>
          }
        />
        <DropdownMenuContent
          ref={popup}
          aria-label="loki"
          align="start"
          sideOffset={4}
          finalFocus={() => {
            const a = document.activeElement;
            if (a && a !== document.body && !popup.current?.contains(a)) return false;
            return trigger.current ?? true;
          }}
          className={cx("loki-popover loki-popover--anchored", !grows && "data-open:animate-none")}
          style={{ minWidth: 180 }}
        >
          <TitleMenuItems groups={titleMenus(os, KEYMAP, labels)} os={os} onPick={runMenuItem} />
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
