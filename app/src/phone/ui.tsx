import type { CSSProperties, ReactNode } from "react";
import { Button } from "../components";

/**
 * The phone's few shared pieces: a top bar that clears the notch, the scrolling surface under it,
 * the section heading, the back chevron. Controls (buttons, chips, fields, rows, the sheet, the
 * banner) are the app's primitives in ui/; brass is spent only on what waits for you.
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
        {right && <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 6 }}>{right}</div>}
      </div>
      {progress !== null && (
        <div aria-hidden style={{ height: 2, background: "var(--loki-border)", overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`, background: "var(--loki-accent)", transition: "width 240ms ease-out" }} />
        </div>
      )}
    </header>
  );
}

/**
 * The phone's page-level rules, rendered once. The document itself never scrolls: iOS lets the body
 * rubber-band behind a fixed shell when a drag starts outside a list or a list reaches its end, and the whole
 * shell — tab bar included — drags with it; the keyboard can leave it scrolled, too, so the bar no longer sits
 * at the bottom. Pinning html and body stops that; the lists inside contain their own overscroll (Scroll below).
 * Also the reading measure: the desktop's transcript caps a bubble at 78% of the column; on a phone the column
 * is the measure, so bubbles span the card, 13.5 on 1.45 (the cap is an inline style in chat/Transcript.tsx).
 */
export function PhoneStyles() {
  return (
    <style>{`
html, body { position: fixed; inset: 0; width: 100%; height: 100%; overflow: hidden; overscroll-behavior: none; }
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

/** A scrolling surface under a TopBar and over the tab bar; full-screen children add their own bottom inset. */
export function Scroll({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overscrollBehavior: "contain", WebkitOverflowScrolling: "touch", padding: `12px ${GUTTER.right} 24px ${GUTTER.left}`, ...style }}>
      {children}
    </div>
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

/** The back chevron for the top bar. */
export function BackButton({ onClick, label = "inbox" }: { onClick: () => void; label?: string }) {
  return (
    <Button bare size="touch" tone="paper" onClick={onClick} aria-label={`back to ${label}`} style={{ paddingLeft: 4, paddingRight: 10 }}>
      <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12.5 4 6.5 10l6 6" />
      </svg>
      {label}
    </Button>
  );
}
