import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";
import { TABS, navigate, type Tab } from "./router";

/**
 * The navigation, the way Slack's phone app floats it: a rounded capsule with Home, Inbox, Agents and
 * More — icon over a small label, the current one on a raised pill — and a round Search button beside
 * it, both hovering over the content just above the home indicator. The inbox count sits on Inbox in
 * the unread badge, the same number the desktop rail and the dock badge show.
 *
 * The dock owns the bottom inset while it is on screen, and only it: it measures how much of the shell
 * it covers and publishes that as --phone-nav-clearance on the shell. Scroll owners add it once at the
 * end of their content (phone.css), so the last row scrolls clear of the capsule; screens with a fixed
 * bottom (the Inbox's buttons) stop above it with .loki-phone-above-nav. `children` dock above the
 * capsule — the update bar — and are counted in the clearance.
 */
export function TabBar({ active, waiting, children }: { active: Tab | null; waiting: number; children?: ReactNode }) {
  const dock = useNavClearance();
  return (
    <div ref={dock} className="loki-phone-dock">
      {children}
      <div className="loki-phone-dock-row">
        <nav aria-label="primary" className="loki-phone-nav">
          {TABS.map((t) => {
            const n = t === "inbox" ? waiting : 0;
            return (
              <button key={t} type="button" className="loki-phone-nav-item" onClick={() => navigate({ kind: "tab", tab: t })} aria-label={navLabel(t, n)} aria-current={t === active ? "page" : undefined}>
                <span className="loki-phone-nav-icon">
                  <Icon name={TAB_ICON[t]} size={24} />
                  {n > 0 && (
                    <span aria-hidden className="loki-phone-nav-badge">
                      {badgeText(n)}
                    </span>
                  )}
                </span>
                <span aria-hidden className="loki-phone-nav-label">
                  {TAB_LABEL[t]}
                </span>
              </button>
            );
          })}
        </nav>
        <button type="button" className="loki-phone-search-btn" aria-label="Search" onClick={() => navigate({ kind: "search" })}>
          <Icon name="search" size={24} />
        </button>
      </div>
    </div>
  );
}

export const TAB_LABEL: Record<Tab, string> = { home: "Home", inbox: "Inbox", agents: "Agents", more: "More" };
const TAB_ICON: Record<Tab, IconName> = { home: "home", inbox: "inbox", agents: "agents", more: "more" };

/** The badge's text: the count, capped at 99+ so a big queue never widens the capsule. */
export const badgeText = (n: number): string => (n > 99 ? "99+" : String(n));

/** A tab's accessible name: "Inbox" or "Inbox, 3 waiting". */
export const navLabel = (t: Tab, n: number): string => (n > 0 ? `${TAB_LABEL[t]}, ${badgeText(n)} waiting` : TAB_LABEL[t]);

/** Sets --phone-nav-clearance on the shell to the height the dock covers, from its top to the shell's bottom; removed with the dock. */
function useNavClearance() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const shell = el?.closest<HTMLElement>(".loki-phone-shell");
    if (!el || !shell) return;
    const measure = () => shell.style.setProperty("--phone-nav-clearance", `${Math.max(0, Math.ceil(shell.getBoundingClientRect().bottom - el.getBoundingClientRect().top))}px`);
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    ro?.observe(shell);
    return () => {
      ro?.disconnect();
      shell.style.removeProperty("--phone-nav-clearance");
    };
  }, []);
  return ref;
}
