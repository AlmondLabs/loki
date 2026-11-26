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
import { keyboard, type Platform } from "../workspace/env";
import { lastInput } from "../kit/motion";
import { KEYMAP, formatKeys, keyFor, keysOf, labelOf, menuSpec, runAction, type Binding } from "./keymap";
import { MenuIcon } from "lucide-react";
import { Glyph } from "../shared/icons";

export interface TitleMenuEntry {
  id: string;
  label: string;
  keys: string | null;
}
export interface TitleMenuGroup {
  title: string;
  items: Array<TitleMenuEntry | { separator: true }>;
}

const HIDE = "window.hide";
const HIDE_BINDING: Binding = (() => {
  const b = KEYMAP.find((x) => x.id === HIDE);
  if (!b) throw new Error(`the keymap has no ${HIDE}`);
  return b;
})();

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

export function runMenuItem(id: string): void {
  if (!runAction(id)) console.warn("loki: menu item without an action", id);
}

const keyBefore = (items: TitleMenuGroup["items"], i: number): string => {
  const before = i > 0 ? items[i - 1] : undefined;
  return before && !("separator" in before) ? before.id : "start";
};

const ITEM = "justify-between gap-3";

export function TitleMenuItems({ groups, onPick, os = keyboard }: { groups: TitleMenuGroup[]; onPick: (id: string) => void; os?: Platform }) {
  return (
    <>
      {groups.map((g) => (
        <DropdownMenuSub key={g.title}>
          <DropdownMenuSubTrigger data-menu={g.title}>{g.title}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent aria-label={g.title} className="loki-popover" style={{ minWidth: 260 }}>
            {g.items.map((it, i) =>
              "separator" in it ? (
                <DropdownMenuSeparator key={`sep-after-${keyBefore(g.items, i)}`} />
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
