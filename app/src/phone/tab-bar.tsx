import { useLayoutEffect, useRef, type ReactNode } from "react";
import { countText } from "../components";
import { Icon, type IconName } from "./icons";
import { TABS, navigate, type Tab } from "./router";

export function TabBar({ active, waiting, children }: { active: Tab | null; waiting: number; children?: ReactNode }) {
  const dock = useNavClearance();
  return (
    <div ref={dock} className="loki-phone-dock">
      {children}
      <div className="loki-phone-dock-row">
        <nav aria-label="Primary" className="loki-phone-nav">
          {TABS.map((t) => {
            const n = t === "inbox" ? waiting : 0;
            return (
              <button
                key={t}
                type="button"
                className="loki-phone-nav-item"
                onClick={() => navigate({ kind: "tab", tab: t })}
                aria-label={navLabel(t, n)}
                aria-current={t === active ? "page" : undefined}
              >
                <span className="loki-phone-nav-icon">
                  <Icon name={TAB_ICON[t]} size={24} />
                  {n > 0 && (
                    <span key={n} aria-hidden className="loki-phone-nav-badge">
                      {countText(n)}
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

export const TAB_LABEL: Record<Tab, string> = { home: "Home", inbox: "Flow", agents: "Agents", more: "More" };
const TAB_ICON: Record<Tab, IconName> = { home: "home", inbox: "inbox", agents: "agents", more: "more" };

export const navLabel = (t: Tab, n: number): string => (n > 0 ? `${TAB_LABEL[t]}, ${countText(n)} waiting` : TAB_LABEL[t]);

function useNavClearance() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const shell = el?.closest<HTMLElement>(".loki-phone-shell");
    if (!el || !shell) return;
    const measure = () =>
      shell.style.setProperty("--phone-nav-clearance", `${Math.max(0, Math.ceil(shell.getBoundingClientRect().bottom - el.getBoundingClientRect().top))}px`);
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
