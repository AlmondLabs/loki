import { useRef, type ButtonHTMLAttributes, type ReactElement, type ReactNode } from "react";
import type { MenuPositionerProps } from "@base-ui/react/menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { Meta } from "../components";
import { cx } from "../components/parts";
import { lastInput } from "../kit/motion";
import { formatKeys } from "./keymap";
import { tidyEntries, type MenuEntry } from "./native-menu";
import { CheckIcon } from "lucide-react";
import { Glyph } from "../shared/icons";

/**
 * A menu's entries drawn by loki (plan 2026-11-12-1505, U19), where it cannot pop up a native one: Windows, Linux and
 * the browser. The same items, order, checks and separators as the native menu, the key on the right; a submenu draws
 * as its label over its items. They are Base UI's menu items (plan 2026-11-15-2330, KTD2), so they live inside a
 * `DrawnMenu`, which closes on a pick.
 */
export function MenuItems({ entries }: { entries: MenuEntry[] }) {
  const tidy = tidyEntries(entries);
  // As AppKit does: once one item has an icon, every item's label starts after the icon's column.
  const icons = tidy.some((e) => e.type === "item" && e.icon);
  return tidy.map((e, i) => {
    if (e.type === "separator") return <DropdownMenuSeparator key={`sep-${i}`} />;
    if (e.type === "submenu")
      return (
        <DropdownMenuGroup key={e.id} aria-label={e.label}>
          <DropdownMenuLabel>{e.label}</DropdownMenuLabel>
          <MenuItems entries={e.items} />
        </DropdownMenuGroup>
      );
    const choice = e.checked !== undefined;
    return (
      <DropdownMenuItem
        key={e.id}
        // A choice in a picker says so, and whether it is the one chosen; Base UI lets these win over its own role.
        role={choice ? "menuitemradio" : "menuitem"}
        aria-checked={choice ? e.checked : undefined}
        disabled={e.disabled}
        title={e.hint}
        // A disabled item still shows why it is off when hovered.
        className="justify-between gap-3 data-disabled:pointer-events-auto"
        onClick={() => e.run()}
      >
        <span className="loki-menu-label">
          {icons && <span className="loki-menu-icon">{e.icon && <e.icon aria-hidden />}</span>}
          <span>
            {e.label}
            {e.detail && <Meta> {e.detail}</Meta>}
          </span>
        </span>
        {choice && e.checked ? (
          <span aria-hidden className="loki-menu-check">
            <Glyph icon={CheckIcon} />
          </span>
        ) : (
          e.keys && <DropdownMenuShortcut>{formatKeys(e.keys)}</DropdownMenuShortcut>
        )}
      </DropdownMenuItem>
    );
  });
}

/**
 * A menu drawn by loki on shadcn's DropdownMenu (plan 2026-11-15-2330, KTD2): hung from its button, or from a point
 * (a sidebar row's menu, KTD3). Base UI moves with ↑↓ Home End and type-ahead and closes it on Esc, Tab, a press
 * outside or a pick, with focus back on its opener unless the pick took it elsewhere. Opened by a click it grows out of
 * the corner it hangs from; opened by a key it is simply there.
 */
export function DrawnMenu({
  label,
  entries,
  open,
  onOpenChange,
  trigger,
  at,
  opener,
  anchor = "right",
  side = "below",
  width = 260,
}: {
  label: string;
  entries: MenuEntry[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The button it hangs from. */
  trigger?: ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>;
  /** Or the point it hangs from, in the window, when no button opened it. */
  at?: { x: number; y: number };
  /** Where focus goes back to when it closes, for a menu hung from a point. */
  opener?: () => HTMLElement | null;
  /** The button's edge the menu lines up with. */
  anchor?: "left" | "right";
  /** Under the button (the default), or above it for a button along the window's foot. */
  side?: "below" | "above";
  width?: number;
}) {
  const popup = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const grows = open && lastInput() === "pointer";
  const point: MenuPositionerProps["anchor"] = at ? { getBoundingClientRect: () => DOMRect.fromRect({ x: at.x, y: at.y, width: 0, height: 0 }) } : undefined;
  const content: ReactNode = (
    <DropdownMenuContent
      ref={popup}
      aria-label={label}
      anchor={point}
      side={side === "above" ? "top" : "bottom"}
      align={at || anchor === "left" ? "start" : "end"}
      sideOffset={at ? 0 : 6}
      // Back to what opened it, unless a pick already took focus elsewhere (a sheet it opened).
      finalFocus={() => {
        const a = document.activeElement;
        if (a && a !== document.body && !popup.current?.contains(a)) return false;
        return opener?.() ?? triggerRef.current ?? true;
      }}
      className={cx("loki-popover loki-popover--anchored", !grows && "data-open:animate-none")}
      style={{ width }}
    >
      <MenuItems entries={entries} />
    </DropdownMenuContent>
  );
  return (
    <DropdownMenu open={open} onOpenChange={(next) => onOpenChange(next)}>
      {trigger && <DropdownMenuTrigger ref={triggerRef} render={trigger} />}
      {content}
    </DropdownMenu>
  );
}
