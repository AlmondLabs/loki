import { useEffect, useRef, type ReactNode } from "react";
import { NavButton } from "../components";
import { PAGES, pageAfterKey, pageTitle, type SettingsPage } from "./pages";

/**
 * Preferences' section list: a vertical tablist with a roving tab stop, as TabRow is across. Tab lands on the
 * chosen page; ↑↓, Home and End choose and move focus with it. When the page changes some other way (⌘[ ⌘])
 * while focus is in the list, focus follows the chosen page instead of staying on the old one.
 */
export function PageList({ page, onPick, extra }: { page: SettingsPage; onPick: (p: SettingsPage) => void; extra?: (p: SettingsPage) => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = ref.current;
    if (!list || !list.contains(document.activeElement)) return;
    list.querySelector<HTMLElement>(`[data-page="${page}"]`)?.focus();
  }, [page]);
  return (
    <div
      ref={ref}
      role="tablist"
      aria-label="Preferences sections"
      aria-orientation="vertical"
      style={{ display: "grid", gap: 2 }}
      onKeyDown={(e) => {
        if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
        const next = pageAfterKey(page, e.key);
        if (!next) return;
        e.preventDefault();
        onPick(next);
      }}
    >
      {PAGES.map((p) => {
        const on = p.id === page;
        // aria-selected is the tab's state; the list's highlight keys off it (aria-current is for links).
        return (
          <NavButton key={p.id} role="tab" data-page={p.id} current={on} aria-current={undefined} aria-selected={on} tabIndex={on ? 0 : -1} onClick={() => onPick(p.id)}>
            {pageTitle(p.id)}
            {extra?.(p.id)}
          </NavButton>
        );
      })}
    </div>
  );
}
