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

/**
 * `progress` (0..1) swaps the bottom hairline for a 2px brass bar that fills as a pass goes; the
 * deck uses it for "n of N". null keeps the hairline.
 */
export function TopBar({ left, title, sub, right, progress = null, height = 48 }: { left?: ReactNode; title: ReactNode; sub?: ReactNode; right?: ReactNode; progress?: number | null; /** The row's height; 44 for a bar with no second line. */ height?: number }) {
  return (
    <header style={{ flex: "0 0 auto", paddingTop: SAFE.top, background: "var(--loki-panel)", borderBottom: progress === null ? "1px solid var(--loki-border)" : "none" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, minHeight: height, padding: `0 calc(12px + ${SAFE.right}) 0 calc(8px + ${SAFE.left})` }}>
        {left}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: "var(--loki-display)", fontSize: 17, color: "var(--loki-fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</div>
          {sub && <div style={{ fontSize: 10.5, color: "var(--loki-muted)", fontFamily: "var(--loki-mono)", letterSpacing: "0.06em", marginTop: 2, display: "flex", alignItems: "center", gap: 8, overflow: "hidden", whiteSpace: "nowrap" }}>{sub}</div>}
        </div>
        {right}
      </div>
      {progress !== null && (
        <div aria-hidden style={{ height: 2, background: "var(--loki-border)", overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`, background: "var(--loki-accent)", transition: "width 240ms ease-out" }} />
        </div>
      )}
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

/**
 * The desktop's transcript caps a bubble at 78% of the column — a reading measure for a wide sheet.
 * On a phone the column is the measure: bubbles span the card, 13.5 on 1.45. The bubble's width is an
 * inline style in chat/Transcript.tsx, so this is the one place the phone reaches past it. Rendered once.
 */
export function PhoneStyles() {
  return (
    <style>{`
.loki-phone-thread [data-row="user"] > div, .loki-phone-thread [data-row="assistant"] > div { max-width: 100% !important; font-size: 13.5px; line-height: 1.45; }
.loki-phone-thread [data-row="user"], .loki-phone-thread [data-row="assistant"] { margin: 6px 0 !important; }
.loki-phone-md p, .loki-phone-md ul, .loki-phone-md ol, .loki-phone-md pre, .loki-phone-md blockquote { margin: 0 0 12px; }
.loki-phone-md h1, .loki-phone-md h2, .loki-phone-md h3 { font-family: var(--loki-display); font-weight: 400; margin: 18px 0 8px; }
.loki-phone-md h1 { font-size: 22px; } .loki-phone-md h2 { font-size: 17px; } .loki-phone-md h3 { font-size: 15px; }
.loki-phone-md code { font-family: var(--loki-mono); font-size: 12px; }
.loki-phone-md pre { background: var(--loki-well); border: 1px solid var(--loki-border); border-radius: 8px; padding: 10px 12px; overflow-x: auto; }
`}</style>
  );
}

/** The phone's side margin, with the safe inset: every surface uses the same twelve pixels. */
export const GUTTER = { left: `calc(12px + ${SAFE.left})`, right: `calc(12px + ${SAFE.right})` };

/** A scrolling surface under a TopBar and over the tab bar; the bar carries the bottom inset. */
export function Scroll({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", WebkitOverflowScrolling: "touch", padding: `12px ${GUTTER.right} 24px ${GUTTER.left}`, ...style }}>
      {children}
    </div>
  );
}

/** A filter pill: paper when it is the one chosen, muted otherwise. Brass is not spent on a filter. */
export function Chip({ active, onClick, children, label }: { active: boolean; onClick: () => void; children: ReactNode; label?: string }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={label}
      onClick={onClick}
      className="loki-label"
      style={{ display: "inline-flex", alignItems: "center", gap: 6, minHeight: 32, padding: "4px 12px", border: `1px solid ${active ? "var(--loki-fg)" : "var(--loki-border)"}`, borderRadius: 999, background: active ? "var(--loki-panel-header)" : "transparent", color: active ? "var(--loki-fg)" : "var(--loki-muted)", cursor: "pointer", fontSize: 10.5, whiteSpace: "nowrap", textTransform: "none", letterSpacing: "0.06em", WebkitTapHighlightColor: "transparent", flex: "0 0 auto" }}
    >
      {children}
    </button>
  );
}

/** A section heading in the condensed caps, with room for a count or a note on the right. */
export function Heading({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="loki-label" style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 9.5, padding: "0 4px 6px" }}>
      {children}
      {aside && <span style={{ marginLeft: "auto", letterSpacing: "0.06em", textTransform: "none", fontFamily: "var(--loki-mono)", fontSize: 10.5 }}>{aside}</span>}
    </div>
  );
}

/** Mono meta: agent name, time, model — 10.5, tracked. */
export function Meta({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <span style={{ fontSize: 10.5, color: "var(--loki-muted)", fontFamily: "var(--loki-mono)", letterSpacing: "0.06em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", ...style }}>{children}</span>;
}

/** A text field on the phone: the well, the row radius, 15px so iOS does not zoom in on focus. */
export const FIELD: CSSProperties = { width: "100%", boxSizing: "border-box", minHeight: 44, padding: "10px 12px", fontSize: 15, background: "var(--loki-well)", border: "1px solid var(--loki-border)", borderRadius: 8, color: "var(--loki-fg)", outline: "none", fontFamily: "var(--loki-font)" };

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
