import { useEffect, useRef, useState, type ReactNode } from "react";
import { Field, NavButton } from "../components";
import { GROUPS, groupOf, pageAfterKey, pagesMatching, type SettingsGroup, type SettingsPage } from "./pages";

/**
 * Preferences' section list: a filter, then one row per group (plan 031), a vertical tablist with a roving tab stop, as
 * TabRow is across. A row opens its group on its first page, or the first one the filter left; the group's pages are
 * tabs on its page. Tab lands on the chosen group; ↑↓, Home and End choose among the groups the filter left and move
 * focus with it. When the page changes some other way (⌘[ ⌘]) while focus is in the list, focus follows the chosen group.
 * In the filter, Enter opens the first page left and Esc clears it (an empty one lets Esc close Preferences).
 */
export function PageList({ page, onPick, extra }: { page: SettingsPage; onPick: (p: SettingsPage) => void; extra?: (g: SettingsGroup) => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const shown = pagesMatching(query);
  const groups = GROUPS.map((g) => ({ g, pages: g.pages.filter((p) => shown.includes(p)) })).filter((r) => r.pages.length > 0);
  const current = groupOf(page);
  useEffect(() => {
    const list = ref.current;
    if (!list?.contains(document.activeElement)) return;
    list.querySelector<HTMLElement>(`[data-group="${current.title}"]`)?.focus();
  }, [current]);
  const focusGroup = (g: SettingsGroup) => requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(`[data-group="${g.title}"]`)?.focus());
  // The chosen group keeps the tab stop while it is shown; otherwise the first group left takes it.
  const stop = groups.some((r) => r.g === current) ? current : groups[0]?.g;
  return (
    // The heading and the filter stay; the list under them scrolls when the window is short.
    <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1, minHeight: 0 }}>
      <Field
        size="sm"
        type="search"
        placeholder="filter"
        aria-label="Filter preferences"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && query) {
            e.preventDefault();
            e.stopPropagation();
            setQuery("");
          } else if ((e.key === "Enter" || e.key === "ArrowDown") && shown.length) {
            e.preventDefault();
            const to = shown.includes(page) && e.key === "ArrowDown" ? page : shown[0];
            onPick(to);
            focusGroup(groupOf(to));
          }
        }}
      />
      <div
        ref={ref}
        role="tablist"
        aria-label="Preferences sections"
        aria-orientation="vertical"
        style={{ display: "grid", alignContent: "start", gap: 2, flex: 1, minHeight: 0, overflowY: "auto", scrollbarGutter: "stable", paddingBottom: 16 }}
        onKeyDown={(e) => {
          if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
          const next = pageAfterKey(page, e.key, shown);
          if (!next) return;
          e.preventDefault();
          onPick(next);
        }}
      >
        {groups.map(({ g, pages }) => {
          const on = g === current;
          // aria-selected is the tab's state; the list's highlight keys off it (aria-current is for links).
          return (
            <NavButton
              key={g.title}
              role="tab"
              data-group={g.title}
              current={on}
              aria-current={undefined}
              aria-selected={on}
              tabIndex={g === stop ? 0 : -1}
              onClick={() => onPick(on && pages.includes(page) ? page : pages[0])}
            >
              {g.title}
              {extra?.(g)}
            </NavButton>
          );
        })}
        {!groups.length && (
          <div className="loki-meta loki-meta--wrap" style={{ padding: "8px 10px" }}>
            no page matches
          </div>
        )}
      </div>
    </div>
  );
}
