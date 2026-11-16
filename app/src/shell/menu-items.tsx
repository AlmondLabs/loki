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

export function MenuItems({ entries }: { entries: MenuEntry[] }) {
  const tidy = tidyEntries(entries);
  const icons = tidy.some((e) => e.type === "item" && e.icon);
  let previous = "start";
  return tidy.map((e) => {
    if (e.type === "separator") return <DropdownMenuSeparator key={`sep-after-${previous}`} />;
    previous = e.id;
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
  trigger?: ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>;
  at?: { x: number; y: number };
  opener?: () => HTMLElement | null;
  anchor?: "left" | "right";
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
