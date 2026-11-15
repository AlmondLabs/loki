import { useRef, type ButtonHTMLAttributes, type KeyboardEvent, type ReactElement } from "react";
import { Kbd, Meta, Popover, Row } from "../components";
import { formatKeys } from "./keymap";
import { tidyEntries, type MenuEntry } from "./native-menu";
import { CheckIcon } from "lucide-react";
import { Glyph } from "../shared/icons";

/** The focusable rows of a drawn menu, in order. */
export const menuRows = (node: Element | null | undefined) => [...(node?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? [])];

/**
 * A drawn menu's keys: ↑↓ move, Home and End jump, Esc (and Tab) close. Returns whether the key was the menu's.
 */
export function menuKey(e: KeyboardEvent, node: Element | null, onClose: () => void): boolean {
  const all = menuRows(node);
  const i = all.indexOf(document.activeElement as HTMLElement);
  if (e.key === "ArrowDown") all[Math.min(all.length - 1, i + 1)]?.focus();
  else if (e.key === "ArrowUp") all[Math.max(0, i - 1)]?.focus();
  else if (e.key === "Home") all[0]?.focus();
  else if (e.key === "End") all.at(-1)?.focus();
  else if (e.key === "Escape" || e.key === "Tab") onClose();
  else return false;
  e.preventDefault();
  e.stopPropagation();
  return true;
}

/**
 * A menu's entries drawn by loki (plan 2026-11-12-1505, U19), where it cannot pop up a native one: Windows, Linux and
 * the browser. The same items, order, checks and separators as the native menu, the key on the
 * right; a submenu draws as its label over its items. `onPicked` runs before an item's action (to close the menu).
 */
export function MenuItems({ entries, onPicked }: { entries: MenuEntry[]; onPicked: () => void }) {
  const tidy = tidyEntries(entries);
  // As AppKit does: once one item has an icon, every item's label starts after the icon's column.
  const icons = tidy.some((e) => e.type === "item" && e.icon);
  return tidy.map((e, i) => {
    if (e.type === "separator") return <hr key={`sep-${i}`} className="loki-title-menu-sep" />;
    if (e.type === "submenu")
      return (
        <div key={e.id} role="group" aria-label={e.label}>
          <div role="presentation" className="loki-label loki-menu-group-label">
            {e.label}
          </div>
          <MenuItems entries={e.items} onPicked={onPicked} />
        </div>
      );
    const choice = e.checked !== undefined;
    return (
      <Row
        key={e.id}
        dense
        role={choice ? "menuitemradio" : "menuitem"}
        aria-checked={choice ? e.checked : undefined}
        disabled={e.disabled}
        title={e.hint}
        className="loki-desk-pane-menu-item"
        onClick={() => {
          onPicked();
          e.run();
        }}
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
          e.keys && <Kbd>{formatKeys(e.keys)}</Kbd>
        )}
      </Row>
    );
  });
}

/**
 * A menu drawn by loki, hung from its button on a Popover: ↑↓ / Enter / Esc, or click. A press outside closes it, and
 * focus goes back to the button unless the pick took it elsewhere. It opens on the checked row, else the first.
 */
export function PopoverMenu({
  label,
  entries,
  trigger,
  open,
  onOpenChange,
  anchor = "right",
  side = "below",
  width = 260,
}: {
  label: string;
  entries: MenuEntry[];
  /** The button it hangs from. */
  trigger: ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The button's edge the menu lines up with. */
  anchor?: "left" | "right";
  /** Under the button (the default), or above it for a button along the window's foot. */
  side?: "below" | "above";
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = () => onOpenChange(false);
  return (
    <Popover
      ref={ref}
      trigger={trigger}
      open={open}
      onOpenChange={onOpenChange}
      role="menu"
      aria-label={label}
      anchor={anchor}
      side={side}
      width={width}
      initialFocus={() => ref.current?.querySelector<HTMLElement>('[role^="menuitem"][aria-checked="true"]') ?? menuRows(ref.current).at(0)}
      // hung from a small button: the popover's own cap (its parent's width) would crush it
      style={{ padding: 4, maxWidth: "none" }}
      onKeyDown={(e) => menuKey(e, ref.current, close)}
    >
      <MenuItems entries={entries} onPicked={close} />
    </Popover>
  );
}
