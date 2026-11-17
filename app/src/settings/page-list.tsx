import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Field, NavButton } from "../components";
import { Icon } from "../shared/icons";
import { GROUPS, PAGE_ICON, pageAfterKey, pageTitle, pagesMatching, type SettingsPage } from "./pages";

export const NAV_ROW_PADDING = 8;

export const NAV_TEXT_INSET = NAV_ROW_PADDING + 1;

export function PageList({ page, onPick, extra }: { page: SettingsPage; onPick: (p: SettingsPage) => void; extra?: (p: SettingsPage) => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const shown = pagesMatching(query);
  const groups = GROUPS.map((g) => ({ g, pages: g.pages.filter((p) => shown.includes(p)) })).filter((r) => r.pages.length > 0);
  useEffect(() => {
    const list = ref.current;
    if (!list?.contains(document.activeElement)) return;
    list.querySelector<HTMLElement>(`[data-page="${page}"]`)?.focus();
  }, [page]);
  const focusPage = (p: SettingsPage) => requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(`[data-page="${p}"]`)?.focus());
  const stop = shown.includes(page) ? page : shown[0];
  return (
    <div className="flex flex-col gap-3 flex-1" style={{ minHeight: 0 }}>
      <Field
        size="sm"
        type="search"
        placeholder="Search"
        aria-label="Filter preferences"
        style={{ paddingInline: NAV_ROW_PADDING }}
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
            focusPage(to);
          }
        }}
      />
      <div
        ref={ref}
        role="tablist"
        aria-label="Preferences sections"
        aria-orientation="vertical"
        className="grid content-start gap-0.5 flex-1"
        style={{ minHeight: 0, overflowY: "auto", scrollbarGutter: "stable", paddingBottom: 16 }}
        onKeyDown={(e) => {
          if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
          const next = pageAfterKey(page, e.key, shown);
          if (!next) return;
          e.preventDefault();
          onPick(next);
        }}
      >
        {groups.map(({ g, pages }) => (
          <Fragment key={g.title}>
            {/* A group's name: a heading for the eye only, since a tablist may hold nothing but its tabs. */}
            <div aria-hidden className="loki-settings-heading">
              {g.title}
            </div>
            {pages.map((p) => {
              const on = p === page;
              const mark = PAGE_ICON[p];
              return (
                <NavButton
                  key={p}
                  role="tab"
                  data-page={p}
                  current={on}
                  aria-current={undefined}
                  aria-selected={on}
                  tabIndex={p === stop ? 0 : -1}
                  onClick={() => onPick(p)}
                >
                  <span aria-hidden className="loki-settings-row-icon" style={{ background: mark.tint }}>
                    <Icon name={mark.icon} size={14} />
                  </span>
                  {pageTitle(p)}
                  {extra?.(p)}
                </NavButton>
              );
            })}
          </Fragment>
        ))}
        {!groups.length && (
          <div className="loki-meta loki-meta--wrap" style={{ padding: 8 }}>
            No page matches
          </div>
        )}
      </div>
    </div>
  );
}
