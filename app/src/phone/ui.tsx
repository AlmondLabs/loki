import { useRef, type CSSProperties, type ReactNode } from "react";
import { Button } from "../components";
import { Icon } from "./icons";
import { useScrollMemory } from "./session";

/**
 * The phone's few shared pieces: a top bar that clears the notch, the scrolling surface under it,
 * the section heading, the back chevron. Controls (buttons, chips, fields, rows, the sheet, the
 * banner) are the app's primitives in components/, dressed for the phone by phone.css.
 */

/** The notch and the home indicator: iOS reports them as env() insets once the viewport is `viewport-fit=cover`. */
export const SAFE = {
  top: "env(safe-area-inset-top, 0px)",
  bottom: "env(safe-area-inset-bottom, 0px)",
  left: "env(safe-area-inset-left, 0px)",
  right: "env(safe-area-inset-right, 0px)",
};

/**
 * `progress` (0..1) swaps the bottom hairline for a 2px bar that fills as a pass goes; the deck uses it
 * for "n of N". null keeps the hairline. Static looks are classes in phone.css; only the row height and
 * the fill are inline, since they come from the caller. The title is the screen's heading: the one
 * element focus moves to when a route opens (session.ts restoreFocus), hence tabIndex -1.
 */
export function TopBar({ left, title, sub, right, progress = null, height = 48 }: { left?: ReactNode; title: ReactNode; sub?: ReactNode; right?: ReactNode; progress?: number | null; /** The row's height; 44 for a bar with no second line. */ height?: number }) {
  return (
    <header className={progress === null ? "loki-phone-topbar" : "loki-phone-topbar loki-phone-topbar--progress"}>
      <div className="loki-phone-topbar-row" style={{ minHeight: height }}>
        {left}
        <div className="loki-phone-topbar-copy">
          <h1 className="loki-phone-title loki-phone-topbar-title" data-phone-heading tabIndex={-1}>
            {title}
          </h1>
          {sub && <div className="loki-phone-topbar-sub">{sub}</div>}
        </div>
        {right && <div className="loki-phone-topbar-actions">{right}</div>}
      </div>
      {progress !== null && (
        <div aria-hidden className="loki-phone-progress">
          <div className="loki-phone-progress-fill" style={{ width: `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%` }} />
        </div>
      )}
    </header>
  );
}

/** The phone's side margin, with the safe inset: every surface uses the same gutter (--phone-gutter, Slack's 16). */
export const GUTTER = { left: `calc(var(--phone-gutter) + ${SAFE.left})`, right: `calc(var(--phone-gutter) + ${SAFE.right})` };

/**
 * A scrolling surface under a TopBar. Its end clears the floating navigation when that is on screen
 * (phone.css); full-screen children add their own bottom inset. `memory` names the destination whose
 * offset it keeps, so a tab switch or a page and back returns to the same place (session.ts).
 */
export function Scroll({ children, style, memory }: { children: ReactNode; style?: CSSProperties; memory?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useScrollMemory(ref, memory);
  return (
    <div ref={ref} className="loki-phone-scroll" style={style}>
      {children}
    </div>
  );
}

/** A section heading, sentence case in bold sans, with room for a count or a note on the right. */
export function Heading({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="loki-phone-heading">
      {children}
      {/* a count of 0 is still an aside, not a stray "0" beside the title */}
      {aside != null && aside !== false && <span className="loki-phone-heading-aside">{aside}</span>}
    </div>
  );
}

/** The back chevron for the top bar. */
export function BackButton({ onClick, label = "inbox" }: { onClick: () => void; label?: string }) {
  return (
    <Button bare size="touch" tone="paper" onClick={onClick} aria-label={`back to ${label}`} className="loki-phone-back">
      <Icon name="back" size={22} />
      {label}
    </Button>
  );
}
