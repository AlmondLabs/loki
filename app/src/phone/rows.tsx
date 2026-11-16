import { useRef, type ReactNode } from "react";
import { countText } from "../components";
import { AgentFace } from "../desk/agent-chip";
import { Icon, type IconName } from "./icons";

export function useHold(onHold: (() => void) | null | undefined) {
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  const start = () => {
    if (!onHold) return;
    held.current = false;
    hold.current = setTimeout(() => {
      held.current = true;
      onHold();
    }, 550);
  };
  const end = () => {
    if (hold.current) clearTimeout(hold.current);
    hold.current = null;
  };
  const tap = (fn: () => void) => () => {
    if (held.current) {
      held.current = false;
      return;
    }
    fn();
  };
  return { start, end, tap };
}

export function Avatar({ name, src, size = 36, presence }: { name: string | null | undefined; src: string | null; size?: number; presence?: boolean }) {
  return (
    <span className="loki-phone-avatar">
      <AgentFace name={name} src={src} size={size} />
      {presence !== undefined && <span aria-hidden className="loki-phone-presence" data-on={presence} />}
    </span>
  );
}

export function RowIcon({ name }: { name: IconName }) {
  return (
    <span aria-hidden className="loki-phone-row-icon">
      <Icon name={name} size={22} />
    </span>
  );
}

export interface PhoneRowProps {
  lead?: ReactNode;
  title: ReactNode;
  preview?: ReactNode;
  time?: string | null;
  badge?: number | null;
  unread?: boolean;
  flags?: ReactNode;
  label?: string;
  onOpen: () => void;
  onActions?: (() => void) | null;
  actionsLabel?: string;
  dim?: boolean;
  live?: boolean;
  launch?: string;
  flip?: string;
}

export function PhoneRow({
  lead,
  title,
  preview,
  time,
  badge,
  unread = false,
  flags,
  label,
  onOpen,
  onActions,
  actionsLabel,
  dim = false,
  live = false,
  launch,
  flip,
}: PhoneRowProps) {
  const hold = useHold(onActions);
  const count = badge != null && badge > 0 ? badge : null;
  return (
    <li className="loki-phone-row-item" data-dim={dim || undefined} data-flip={flip}>
      <button
        type="button"
        className={unread ? "loki-phone-row loki-phone-row--unread" : "loki-phone-row"}
        data-launch={launch}
        aria-label={label}
        onClick={hold.tap(onOpen)}
        onPointerDown={hold.start}
        onPointerUp={hold.end}
        onPointerCancel={hold.end}
        onPointerLeave={hold.end}
        onContextMenu={(e) => {
          if (!onActions) return;
          e.preventDefault();
          hold.end();
          onActions();
        }}
      >
        {lead}
        <span className="loki-phone-row-copy">
          <span className="loki-phone-row-title">
            <span className="loki-phone-ellipsis">{title}</span>
            {flags}
          </span>
          {preview && <span className="loki-phone-row-preview">{preview}</span>}
        </span>
        {count !== null ? (
          <span className="loki-phone-badge">{countText(count)}</span>
        ) : live ? (
          <span aria-hidden className="loki-phone-row-live" />
        ) : time ? (
          <span className="loki-phone-row-time">{time}</span>
        ) : null}
      </button>
      {onActions && (
        <button
          type="button"
          className="loki-phone-row-more loki-phone-icon-btn"
          aria-label={actionsLabel ?? "Actions"}
          aria-haspopup="dialog"
          onClick={onActions}
        >
          <Icon name="more" size={20} />
        </button>
      )}
    </li>
  );
}

export function RowSection({
  icon,
  lead,
  title,
  aside,
  count,
  open = true,
  onToggle,
  onTitle,
  titleLabel,
  children,
}: {
  icon: IconName;
  lead?: ReactNode;
  title: string;
  aside?: ReactNode;
  count?: number | null;
  open?: boolean;
  onToggle?: () => void;
  onTitle?: () => void;
  titleLabel?: string;
  children: ReactNode;
}) {
  const inner = (
    <>
      {lead ?? <Icon name={icon} size={18} />}
      <span className="loki-phone-section-title">
        {title}
        {aside && <span className="loki-phone-section-aside"> · {aside}</span>}
      </span>
      {count != null && count > 0 && <span className="loki-phone-section-count">{countText(count)}</span>}
      {(onTitle ?? onToggle) && (
        <Icon
          name={onTitle ? "chevron-right" : "chevron-down"}
          size={18}
          className={onToggle && !open ? "loki-phone-section-chev loki-phone-section-chev--folded" : "loki-phone-section-chev"}
        />
      )}
    </>
  );
  return (
    <section className="loki-phone-section" aria-label={title}>
      <h2 className="loki-phone-section-head" data-flip={`head:${title}`}>
        {onTitle ? (
          <button type="button" className="loki-phone-section-btn" data-launch={`section:${title}`} aria-label={titleLabel} onClick={onTitle}>
            {inner}
          </button>
        ) : onToggle ? (
          <button type="button" className="loki-phone-section-btn" aria-expanded={open} onClick={onToggle}>
            {inner}
          </button>
        ) : (
          <span className="loki-phone-section-btn">{inner}</span>
        )}
      </h2>
      {open && children}
    </section>
  );
}

export function RowGroup({ title, radio = false, children }: { title?: string; radio?: boolean; children: ReactNode }) {
  return (
    <section className="loki-phone-group" aria-label={title}>
      {title && <h2 className="loki-phone-group-title">{title}</h2>}
      <ul className="loki-phone-list" role={radio ? "radiogroup" : undefined} aria-label={radio ? title : undefined}>
        {children}
      </ul>
    </section>
  );
}

export function MenuRow({
  icon,
  label,
  aside = null,
  page = false,
  sheet = false,
  danger = false,
  checked,
  disabled = false,
  launch,
  onClick,
}: {
  icon: IconName;
  label: string;
  aside?: ReactNode;
  page?: boolean;
  sheet?: boolean;
  danger?: boolean;
  checked?: boolean;
  disabled?: boolean;
  launch?: string;
  onClick: () => void;
}) {
  const cls = danger ? "loki-phone-menu-row loki-phone-menu-row--danger" : "loki-phone-menu-row";
  return (
    <li role={checked === undefined ? undefined : "none"}>
      <button
        type="button"
        className={cls}
        data-launch={launch}
        role={checked === undefined ? undefined : "radio"}
        aria-checked={checked}
        aria-haspopup={sheet ? "dialog" : undefined}
        disabled={disabled}
        onClick={onClick}
      >
        <Icon name={icon} size={22} />
        <span className="loki-phone-menu-row-label">{label}</span>
        {aside != null && aside !== false && <span className="loki-phone-menu-row-aside">{aside}</span>}
        {page && <Icon name="chevron-right" size={18} className="loki-phone-menu-row-chev" />}
        {checked !== undefined && <Icon name="check" size={20} className="loki-phone-menu-row-check" />}
      </button>
    </li>
  );
}

export function FactRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <li className="loki-phone-fact">
      <span className="loki-phone-fact-label">{label}</span>
      <span className="loki-phone-fact-value">{value}</span>
    </li>
  );
}

export function StateWord({ state, children }: { state: "on" | "wait" | "off"; children: ReactNode }) {
  return (
    <span className="loki-phone-state">
      <span aria-hidden className="loki-phone-state-dot" data-state={state} />
      {children}
    </span>
  );
}

const SKELETON_WIDTHS = [
  [62, 84],
  [48, 70],
  [70, 58],
  [54, 78],
  [66, 64],
] as const;

export function SkeletonRows({ label, rows = 4 }: { label: string; rows?: number }) {
  return (
    <div className="loki-phone-skeleton" role="status">
      <span className="loki-phone-sr-only">{label}</span>
      <ul aria-hidden className="loki-phone-list">
        {SKELETON_WIDTHS.slice(0, rows).map(([title, preview]) => (
          <li key={`${title}-${preview}`} className="loki-phone-row">
            <span className="loki-phone-skel loki-phone-skel--face" />
            <span className="loki-phone-row-copy">
              <span className="loki-phone-skel loki-phone-skel--line" style={{ width: `${title}%` }} />
              <span className="loki-phone-skel loki-phone-skel--line loki-phone-skel--thin" style={{ width: `${preview}%` }} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SkeletonCard({ label }: { label: string }) {
  return (
    <div className="loki-phone-skeleton loki-phone-skel-card" role="status">
      <span className="loki-phone-sr-only">{label}</span>
      <div aria-hidden className="loki-phone-skel-card-head">
        <span className="loki-phone-skel loki-phone-skel--face" />
        <span className="loki-phone-row-copy">
          <span className="loki-phone-skel loki-phone-skel--line" style={{ width: "46%" }} />
          <span className="loki-phone-skel loki-phone-skel--line loki-phone-skel--thin" style={{ width: "68%" }} />
        </span>
      </div>
      {[92, 84, 88, 52].map((w) => (
        <span key={w} aria-hidden className="loki-phone-skel loki-phone-skel--line" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}
