import type { CSSProperties, ReactNode } from "react";

/**
 * The phone's few shared pieces: a top bar that clears the notch, the
 * "Mac unreachable" banner, and one tap-sized button style. Everything is the
 * desk's tokens and type scale; brass is spent only on what waits for you.
 */

/** The notch and the home indicator: iOS reports them as env() insets once the viewport is `viewport-fit=cover`. */
export const SAFE = {
  top: "env(safe-area-inset-top, 0px)",
  bottom: "env(safe-area-inset-bottom, 0px)",
  left: "env(safe-area-inset-left, 0px)",
  right: "env(safe-area-inset-right, 0px)",
};

export function TopBar({ left, title, sub, right }: { left?: ReactNode; title: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <header style={{ flex: "0 0 auto", paddingTop: SAFE.top, background: "var(--loki-panel)", borderBottom: "1px solid var(--loki-border)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 48, padding: `0 calc(12px + ${SAFE.right}) 0 calc(8px + ${SAFE.left})` }}>
        {left}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: "var(--loki-display)", fontSize: 17, color: "var(--loki-fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</div>
          {sub && <div style={{ fontSize: 10.5, color: "var(--loki-muted)", fontFamily: "var(--loki-mono)", letterSpacing: "0.06em", marginTop: 2, display: "flex", alignItems: "center", gap: 8, overflow: "hidden", whiteSpace: "nowrap" }}>{sub}</div>}
        </div>
        {right}
      </div>
    </header>
  );
}

/** The Mac is not answering: the sockets are closed and reconnecting by themselves. */
export function Banner({ children }: { children: ReactNode }) {
  return (
    <div role="status" style={{ flex: "0 0 auto", padding: "8px 14px", background: "var(--loki-panel-header)", borderBottom: "1px solid var(--loki-border)", borderLeft: "3px solid var(--loki-negative)", fontSize: 12, color: "var(--loki-muted)", fontFamily: "var(--loki-mono)", letterSpacing: "0.06em" }}>
      {children}
    </div>
  );
}

/** A finger-sized button: 40px tall, the row radius, coloured text on a hairline. */
export function tap(color = "var(--loki-muted)", extra: CSSProperties = {}): CSSProperties {
  return {
    minHeight: 40,
    padding: "8px 14px",
    borderRadius: 8,
    border: "1px solid var(--loki-border)",
    background: "transparent",
    color,
    fontSize: 13.5,
    fontFamily: "var(--loki-font)",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
    touchAction: "manipulation",
    ...extra,
  };
}

/** The back chevron for the top bar. */
export function BackButton({ onClick, label = "inbox" }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={`back to ${label}`} style={{ ...tap("var(--loki-fg)"), border: "none", padding: "8px 10px 8px 4px" }}>
      <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12.5 4 6.5 10l6 6" />
      </svg>
      <span style={{ fontSize: 13.5 }}>{label}</span>
    </button>
  );
}
