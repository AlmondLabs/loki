import { useCallback, useRef, type CSSProperties, type ReactNode } from "react";
import { useFlip } from "../kit/use-flip";
import { Button, Sheet } from "../components";
import { Icon } from "./icons";
import { useHeightVar } from "../shared/use-height-var";
import { useScrollMemory } from "./session";

export function useTopClearance<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useHeightVar(
    useCallback(() => ref.current, []),
    "--phone-top-clearance",
  );
  return ref;
}

export function TopBar({
  left,
  title,
  sub,
  right,
  banner,
  progress = null,
  height = 48,
}: {
  left?: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
  banner?: ReactNode;
  progress?: number | null;
  height?: number;
}) {
  const ref = useTopClearance<HTMLElement>();
  return (
    <header ref={ref} className="loki-phone-topbar">
      <div className="loki-phone-topbar-row" style={{ minHeight: height }}>
        {left && <div className="loki-phone-topbar-group">{left}</div>}
        <div className="loki-phone-topbar-copy">
          <h1 className="loki-phone-title loki-phone-topbar-title" data-phone-heading tabIndex={-1}>
            {title}
          </h1>
          {sub && <div className="loki-phone-topbar-sub">{sub}</div>}
        </div>
        {right && <div className="loki-phone-topbar-group loki-phone-topbar-actions">{right}</div>}
      </div>
      {banner}
      {progress !== null && (
        <div aria-hidden className="loki-phone-progress">
          <div className="loki-phone-progress-fill" style={{ transform: `scaleX(${Math.max(0, Math.min(1, progress)).toFixed(3)})` }} />
        </div>
      )}
    </header>
  );
}

export function Scroll({
  children,
  style,
  memory,
  flush = false,
  flip,
}: {
  children: ReactNode;
  style?: CSSProperties;
  memory?: string;
  flush?: boolean;
  flip?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useScrollMemory(ref, memory);
  useFlip(ref, flip);
  return (
    <div ref={ref} className={flush ? "loki-phone-scroll loki-phone-scroll--flush" : "loki-phone-scroll"} style={style}>
      {children}
    </div>
  );
}

export function BackButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" className="loki-phone-icon-btn" onClick={onClick} aria-label={`Back to ${label}`}>
      <Icon name="back" size={22} />
    </button>
  );
}

export function ConfirmSheet({
  title,
  children,
  action,
  busyAction,
  tone = "negative",
  busy = false,
  error = null,
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  action: string;
  busyAction?: string;
  tone?: "negative" | "brass";
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
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
