import { useEffect, useRef, type KeyboardEvent } from "react";
import { Kbd, Meta, Popover, Row } from "../components";
import { formatKeys } from "./keymap";
import { tidyEntries, type MenuEntry } from "./native-menu";

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
 * A menu's entries drawn by loki (plan 2026-11-12-1505, U19), where it cannot pop up a native one: today's look,
 * Windows, Linux and the browser. The same items, order, checks and separators as the native menu, the key on the
 * right; a submenu draws as its label over its items. `onPicked` runs before an item's action (to close the menu).
 */
export function MenuItems({ entries, onPicked }: { entries: MenuEntry[]; onPicked: () => void }) {
  return tidyEntries(entries).map((e, i) => {
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
        <span>
          {e.label}
          {e.detail && <Meta> {e.detail}</Meta>}
        </span>
        {choice && e.checked ? (
          <span aria-hidden className="loki-menu-check">
            ✓
          </span>
        ) : (
          e.keys && <Kbd>{formatKeys(e.keys)}</Kbd>
        )}
      </Row>
    );
  });
}

/**
 * A menu drawn by loki, hung from the button beside it (both inside one positioned wrapper): ↑↓ / Enter / Esc, or
 * click; a press outside the wrapper closes it, and focus goes back to the button unless the pick took it elsewhere.
 */
export function PopoverMenu({
  label,
  entries,
  onClose,
  anchor = "right",
  width = 260,
}: {
  label: string;
  entries: MenuEntry[];
  onClose: () => void;
  /** The wrapper's edge the menu lines up with. */
  anchor?: "left" | "right";
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    const node = ref.current;
    const wrapper = node?.parentElement ?? null;
    (node?.querySelector<HTMLElement>('[role^="menuitem"][aria-checked="true"]') ?? menuRows(node).at(0))?.focus();
    // a press outside the menu and its button closes it (the button toggles it itself)
    const away = (e: PointerEvent) => {
      if (!wrapper?.contains(e.target as Node)) closeRef.current();
    };
    // capture phase: the rail, the list column and popovers stop pointerdown from bubbling, and a press there must still close it
    window.addEventListener("pointerdown", away, true);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      // Esc, or a pick whose action takes no focus of its own: back to the button the menu hangs from.
      const a = document.activeElement;
      if (!a || a === document.body || node?.contains(a)) wrapper?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
    };
  }, []);
  return (
    <Popover
      ref={ref}
      role="menu"
      aria-label={label}
      anchor={anchor}
      width={width}
      // hung from a small button: the popover's own cap (its parent's width) would crush it
      style={{ padding: 4, [anchor]: 0, maxWidth: "none" }}
      onKeyDown={(e) => menuKey(e, ref.current, onClose)}
    >
      <MenuItems entries={entries} onPicked={onClose} />
    </Popover>
  );
}
