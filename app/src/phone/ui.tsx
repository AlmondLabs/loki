import { useRef, type CSSProperties, type ReactNode } from "react";
import { Button, Sheet } from "../components";
import { Icon } from "./icons";
import { useScrollMemory } from "./session";

/**
 * The phone's few shared pieces: a top bar that clears the notch, the scrolling surface under it,
 * the back chevron, the confirmation sheet. Controls (buttons, chips, fields, rows, the sheet, the
 * banner) are the app's primitives in components/, dressed for the phone by phone.css.
 */

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

/**
 * A scrolling surface under a TopBar. Its end clears the floating navigation when that is on screen
 * (phone.css); full-screen children add their own bottom inset. `memory` names the destination whose
 * offset it keeps, so a tab switch or a page and back returns to the same place (session.ts).
 */
export function Scroll({ children, style, memory, flush = false }: { children: ReactNode; style?: CSSProperties; memory?: string; /** No side gutter: edge-to-edge rows (rows.tsx) carry it inside. */ flush?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useScrollMemory(ref, memory);
  return (
    <div ref={ref} className={flush ? "loki-phone-scroll loki-phone-scroll--flush" : "loki-phone-scroll"} style={style}>
      {children}
    </div>
  );
}

/** The back chevron for the top bar: Slack's bare chevron, named for where it goes ("Back to home"). */
export function BackButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" className="loki-phone-icon-btn" onClick={onClick} aria-label={`Back to ${label}`}>
      <Icon name="back" size={22} />
    </button>
  );
}

/**
 * A confirmation for anything that cannot be taken back or changes the link to the Mac (unpair, reload):
 * a bottom sheet naming the action, what follows and how to recover, then Cancel beside the action. While
 * it runs the action says so and both stay put; a failure keeps the sheet open with the error and the
 * action to try again.
 */
export function ConfirmSheet({ title, children, action, busyAction, tone = "negative", busy = false, error = null, onConfirm, onClose }: { title: string; children: ReactNode; action: string; busyAction?: string; tone?: "negative" | "brass"; busy?: boolean; error?: string | null; onConfirm: () => void; onClose: () => void }) {
  return (
    <Sheet label={title} onClose={busy ? undefined : onClose} placement="bottom" className="loki-phone-sheet">
      <div className="loki-phone-sheet-copy">
        <h2 className="loki-phone-title loki-phone-confirm-title">{title}</h2>
        <div className="loki-phone-body loki-phone-confirm-body">{children}</div>
      </div>
      {error && (
        <p role="alert" className="loki-phone-error">
          {error}
        </p>
      )}
      <div className="loki-phone-sheet-actions">
        <Button size="touch" tone="paper" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button size="touch" tone={tone} disabled={busy} onClick={onConfirm}>
          {busy ? (busyAction ?? action) : error ? "Try again" : action}
        </Button>
      </div>
    </Sheet>
  );
}
