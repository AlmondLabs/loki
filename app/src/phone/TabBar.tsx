import { Icon, type IconName } from "./icons";
import { SAFE } from "./ui";
import { TABS, navigate, type Tab } from "./router";

/**
 * The bottom bar, the way Slack's phone app has one: four tabs, icons from the phone's registry, a
 * label beneath. The active tab is paper; the inbox count sits in the unread badge, the same number
 * the desktop rail and the dock badge show. 52px plus the home indicator.
 */
export const TAB_BAR_HEIGHT = 52;

export function TabBar({ active, waiting }: { active: Tab | null; waiting: number }) {
  return (
    <nav aria-label="tabs" style={{ flex: "0 0 auto", display: "flex", alignItems: "stretch", height: `calc(${TAB_BAR_HEIGHT}px + ${SAFE.bottom})`, paddingBottom: SAFE.bottom, paddingLeft: SAFE.left, paddingRight: SAFE.right, boxSizing: "border-box", background: "var(--loki-panel)", borderTop: "1px solid var(--loki-border)" }}>
      {TABS.map((t) => {
        const on = t === active;
        const n = t === "inbox" ? waiting : 0;
        return (
          <button
            key={t}
            type="button"
            onClick={() => navigate({ kind: "tab", tab: t })}
            aria-label={n > 0 ? `${t}, ${n} waiting` : t}
            aria-current={on ? "page" : undefined}
            style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3, border: "none", background: "transparent", color: on ? "var(--loki-fg)" : "var(--loki-muted)", cursor: "pointer", padding: 0, WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}
          >
            <span style={{ position: "relative", display: "grid", placeItems: "center", width: 28, height: 24 }}>
              <Icon name={TAB_ICON[t]} size={22} />
              {n > 0 && (
                <span aria-hidden style={{ position: "absolute", top: -4, right: -8, minWidth: 16, height: 16, padding: "0 4px", boxSizing: "border-box", borderRadius: 999, background: "var(--phone-unread)", color: "var(--phone-on-unread)", border: "2px solid var(--loki-panel)", fontFamily: "var(--loki-font)", fontSize: 11, fontWeight: 700, lineHeight: "12px", textAlign: "center", fontVariantNumeric: "tabular-nums" }}>
                  {n > 99 ? "99+" : n}
                </span>
              )}
            </span>
            <span className="loki-label" style={{ fontSize: 11, color: "inherit" }}>
              {t}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

/** Each tab's glyph from the phone's icon registry. */
const TAB_ICON: Record<Tab, IconName> = { home: "home", inbox: "inbox", agents: "agents", you: "person" };
