import type { KeyboardEvent } from "react";
import { Kbd, Meta, Row } from "../components";
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
