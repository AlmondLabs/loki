import { useRef, type ReactNode } from "react";
import { AgentFace } from "../desk/AgentChip";
import { Icon, type IconName } from "./icons";

/**
 * The phone's one list row, Slack's anatomy: an avatar or an icon at the start, the title (bold when
 * something is new in it) over one muted preview line, and on the right either the time or an unread
 * badge. Home, Archive and, later, Agents and Search draw their lists with it, so every list reads the
 * same. The whole row is one button; its actions (pin, archive…) open from a long press, a right-click
 * or the context-menu key, and from a trailing button that stays out of sight until it has focus, so
 * keyboards and screen readers reach them too.
 */

/**
 * A long press: `onHold` fires after 550ms with the finger still down, and the tap that ends that press
 * is swallowed so the row does not also open. Owns the timer and the "held" flag; hands back the row's
 * pointer handlers and a wrapper for its click.
 */
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

/** An agent's face at row size; `presence` adds Slack's dot at the corner (true: on, false: a hollow ring). */
export function Avatar({ name, src, size = 36, presence }: { name: string | null | undefined; src: string | null; size?: number; presence?: boolean }) {
  return (
    <span className="loki-phone-avatar">
      <AgentFace name={name} src={src} size={size} />
      {presence !== undefined && <span aria-hidden className="loki-phone-presence" data-on={presence} />}
    </span>
  );
}

/** An icon in the avatar's place: the # before a desk, the archive box. */
export function RowIcon({ name }: { name: IconName }) {
  return (
    <span aria-hidden className="loki-phone-row-icon">
      <Icon name={name} size={22} />
    </span>
  );
}

/** "99+" past two digits, as the navigation's badge does. */
const badgeCount = (n: number) => (n > 99 ? "99+" : String(n));

export interface PhoneRowProps {
  /** The start: an Avatar or a RowIcon. */
  lead: ReactNode;
  title: ReactNode;
  /** One muted line under the title, e.g. "friday · needs approval". */
  preview?: ReactNode;
  /** Quiet text on the right ("3h"); the badge takes its place when there is one. */
  time?: string | null;
  /** The unread badge: a number draws a count pill, true a dot; null or false draws nothing. */
  badge?: number | boolean | null;
  /** Bold title in full ink: something in it is new. */
  unread?: boolean;
  /** Small marks after the title, e.g. the pin. */
  flags?: ReactNode;
  /** The row button's accessible name; the visible text when omitted. */
  label?: string;
  onOpen: () => void;
  /** Opens the row's actions; null or omitted, the row has none. */
  onActions?: (() => void) | null;
  /** The trailing actions button's name, e.g. "Actions for Loki mobile". */
  actionsLabel?: string;
  /** Drawn quieter: an archived desk. */
  dim?: boolean;
  /** `data-launch`, so focus comes back to this row after the page it opened (session.ts). */
  launch?: string;
}

/** One row inside a `<ul className="loki-phone-list">`. */
export function PhoneRow({ lead, title, preview, time, badge, unread = false, flags, label, onOpen, onActions, actionsLabel, dim = false, launch }: PhoneRowProps) {
  const hold = useHold(onActions);
  const count = typeof badge === "number" && badge > 0 ? badge : null;
  const dot = badge === true;
  return (
    <li className="loki-phone-row-item" data-dim={dim || undefined}>
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
          <span className="loki-phone-badge">{badgeCount(count)}</span>
        ) : dot ? (
          <span className="loki-phone-badge loki-phone-badge--dot">
            <span className="loki-phone-sr-only">new</span>
          </span>
        ) : time ? (
          <span className="loki-phone-row-time">{time}</span>
        ) : null}
      </button>
      {onActions && (
        <button type="button" className="loki-phone-row-more loki-phone-icon-btn" aria-label={actionsLabel ?? "Actions"} aria-haspopup="dialog" onClick={onActions}>
          <Icon name="more" size={20} />
        </button>
      )}
    </li>
  );
}

/**
 * A Slack section: an icon, a bold title, a count, and on the right either a chevron that folds the
 * list (`open` + `onToggle`) or one that opens the section's own page (`onTitle`). Folded, the list is
 * not rendered, and the header says so with aria-expanded.
 */
export function RowSection({ icon, title, count, open = true, onToggle, onTitle, titleLabel, children }: { icon: IconName; title: string; count?: number | null; open?: boolean; onToggle?: () => void; onTitle?: () => void; /** The header button's name when it opens a page. */ titleLabel?: string; children: ReactNode }) {
  const inner = (
    <>
      <Icon name={icon} size={18} />
      <span className="loki-phone-section-title">{title}</span>
      {count != null && count > 0 && <span className="loki-phone-section-count">{badgeCount(count)}</span>}
      {(onTitle || onToggle) && <Icon name={onTitle ? "chevron-right" : "chevron-down"} size={18} className={onToggle && !open ? "loki-phone-section-chev loki-phone-section-chev--folded" : "loki-phone-section-chev"} />}
    </>
  );
  return (
    <section className="loki-phone-section" aria-label={title}>
      <h2 className="loki-phone-section-head">
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

/**
 * A group of utility rows, Slack's You and Preferences grammar: an optional quiet heading, then rows on
 * hairlines. More, Preferences, the connection and About are built from these and the rows below.
 */
export function RowGroup({ title, radio = false, children }: { title?: string; /** The rows are one choice (MenuRow `checked`): the list is a radio group named by the title. */ radio?: boolean; children: ReactNode }) {
  return (
    <section className="loki-phone-group" aria-label={title}>
      {title && <h2 className="loki-phone-group-title">{title}</h2>}
      <ul className="loki-phone-list" role={radio ? "radiogroup" : undefined} aria-label={radio ? title : undefined}>
        {children}
      </ul>
    </section>
  );
}

/**
 * One utility row: an icon, the name, a quiet aside, and a chevron when it opens a page (`page`). A row that
 * opens a sheet says so with aria-haspopup; `danger` draws a destructive one in the negative colour, and
 * `checked` turns the row into one choice of a radio group. `launch` brings focus back to it (session.ts).
 */
export function MenuRow({ icon, label, aside = null, page = false, sheet = false, danger = false, checked, disabled = false, launch, onClick }: { icon: IconName; label: string; aside?: ReactNode; page?: boolean; sheet?: boolean; danger?: boolean; checked?: boolean; disabled?: boolean; launch?: string; onClick: () => void }) {
  const cls = danger ? "loki-phone-menu-row loki-phone-menu-row--danger" : "loki-phone-menu-row";
  return (
    <li role={checked === undefined ? undefined : "none"}>
      <button type="button" className={cls} data-launch={launch} role={checked === undefined ? undefined : "radio"} aria-checked={checked} aria-haspopup={sheet ? "dialog" : undefined} disabled={disabled} onClick={onClick}>
        <Icon name={icon} size={22} />
        <span className="loki-phone-menu-row-label">{label}</span>
        {aside != null && aside !== false && <span className="loki-phone-menu-row-aside">{aside}</span>}
        {page && <Icon name="chevron-right" size={18} className="loki-phone-menu-row-chev" />}
        {checked !== undefined && <Icon name="check" size={20} className="loki-phone-menu-row-check" />}
      </button>
    </li>
  );
}

/** A fact, not a control: its name on the left, the value on the right, wrapping under it when long. */
export function FactRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <li className="loki-phone-fact">
      <span className="loki-phone-fact-label">{label}</span>
      <span className="loki-phone-fact-value">{value}</span>
    </li>
  );
}

/** A link's state: a dot and its word, so it is never told by colour alone. `on` fills the dot, `off` rings it red. */
export function StateWord({ state, children }: { state: "on" | "wait" | "off"; children: ReactNode }) {
  return (
    <span className="loki-phone-state">
      <span aria-hidden className="loki-phone-state-dot" data-state={state} />
      {children}
    </span>
  );
}
