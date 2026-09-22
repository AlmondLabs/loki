import { SAFE } from "./ui";
import { TABS, navigate, type Tab } from "./router";

/**
 * The bottom bar, the way Slack's phone app has one: four tabs, icons in the rail's line, condensed
 * caps beneath. The active tab is paper; brass appears only on the inbox count, which is the same
 * number the desktop rail and the dock badge show. 52px plus the home indicator.
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
              <Icon tab={t} />
              {n > 0 && (
                <span aria-hidden style={{ position: "absolute", top: -4, right: -8, minWidth: 16, height: 16, padding: "0 4px", boxSizing: "border-box", borderRadius: 999, background: "var(--loki-accent)", color: "var(--loki-bg)", border: "2px solid var(--loki-panel)", fontFamily: "var(--loki-mono)", fontSize: 9.5, fontWeight: 600, lineHeight: "12px", textAlign: "center", fontVariantNumeric: "tabular-nums" }}>
                  {n > 99 ? "99+" : n}
                </span>
              )}
            </span>
            <span className="loki-label" style={{ fontSize: 9.5, letterSpacing: "0.14em", color: "inherit" }}>
              {t}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

/** Icons in the rail's line: 20-unit box, 1.4 stroke, round joins. */
const common = { width: 20, height: 20, viewBox: "0 0 20 20", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

function Icon({ tab }: { tab: Tab }) {
  if (tab === "home") {
    // the sheet with two plates: the desks
    return (
      <svg {...common} aria-hidden>
        <rect x="2.5" y="3.5" width="15" height="13" rx="1.5" />
        <rect x="5" y="6" width="5" height="4" rx="0.8" />
        <rect x="11.5" y="6" width="3.5" height="8" rx="0.8" />
      </svg>
    );
  }
  if (tab === "inbox") {
    // a tray
    return (
      <svg {...common} aria-hidden>
        <path d="M3 11.5V15a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 17 15v-3.5" />
        <path d="M3 11.5h4l1.2 2h3.6l1.2-2h4" />
        <path d="M5.5 11.5 7 4.5h6l1.5 7" />
      </svg>
    );
  }
  if (tab === "agents") {
    // two faces
    return (
      <svg {...common} aria-hidden>
        <circle cx="7" cy="7.5" r="3" />
        <path d="M2.5 16.5c0-2.8 2-4.5 4.5-4.5s4.5 1.7 4.5 4.5" />
        <circle cx="14" cy="8.5" r="2.4" />
        <path d="M13 12.6c2.6 0 4.5 1.6 4.5 3.9" />
      </svg>
    );
  }
  // you: one person, kept quieter than the agent group
  return (
    <svg {...common} aria-hidden>
      <circle cx="10" cy="7" r="3.2" />
      <path d="M4 17c0-3.5 2.6-5.5 6-5.5s6 2 6 5.5" />
    </svg>
  );
}
