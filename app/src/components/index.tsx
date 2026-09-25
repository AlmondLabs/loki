import type { ButtonHTMLAttributes, CSSProperties, HTMLAttributes, InputHTMLAttributes, KeyboardEvent, MouseEvent, ReactNode, Ref, TextareaHTMLAttributes } from "react";
import { forwardRef, useEffect, useRef } from "react";
import { LAYER } from "../kit/layers";
import { Icon, type IconName } from "../shared/icons";

/**
 * The app's primitives: the one Button, Chip, Field, Row, Sheet, Popover and the small text pieces, and the
 * desktop's Slack building blocks (ListRow, ListSection, PaneHeader with its TabRow, EmptyPane).
 * States (hover, focus, active, disabled, pressed, current) live in components/components.css; a call site chooses a size
 * and a tone and never restyles a state. `className` and `style` are the escape hatch for a one-off, and
 * a one-off that repeats becomes a modifier here. Widgets on the sheet keep their own kit (kit/index.tsx).
 */

/**
 * Button tones. The names predate the Slack direction (2026-09-23) and are kept for compatibility:
 * quiet muted ink · paper fg ink · brass the interactive blue (accent ink on a hairline) · positive Slack's
 * green affirmative, filled · negative red ink. "Needs you" is the red attention badge, not a tone.
 */
export type Tone = "quiet" | "paper" | "brass" | "positive" | "negative";
export type Size = "sm" | "md" | "touch";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

/** Sentence case for a label built from an id ("inbox" → "Inbox"); labels are shown as written, never transformed. */
export const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** What Tab can land on inside a sheet. */
const FOCUSABLE = 'a[href], button, input, textarea, select, summary, [tabindex]:not([tabindex="-1"])';

const BTN_SIZE: Record<Size, string> = { sm: "loki-btn--sm", md: "loki-btn--md", touch: "loki-btn--touch" };
const BTN_TONE: Record<Tone, string | null> = { quiet: null, paper: "loki-btn--paper", brass: "loki-btn--brass", positive: "loki-btn--positive", negative: "loki-btn--negative" };

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: Tone;
  /** sm 28 (desktop default) · md 36 · touch 44 (the phone). */
  size?: Size;
  /** No hairline: header actions, inline actions. */
  bare?: boolean;
  /** Fills the row, label left. */
  block?: boolean;
  /** A shortcut hint after the label, e.g. "⌘↵". */
  kbd?: ReactNode;
}

/** The button. Coloured text on a hairline, or green filled for the affirmative (`positive`). */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ tone = "quiet", size = "sm", bare, block, kbd, className, children, type = "button", ...rest }, ref) {
  return (
    <button ref={ref} type={type} className={cx("loki-btn", BTN_SIZE[size], BTN_TONE[tone], bare && "loki-btn--bare", block && "loki-btn--block", className)} {...rest}>
      {children}
      {kbd != null && <Kbd>{kbd}</Kbd>}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** The accessible name; also the tooltip unless `title` is given. */
  label: string;
  /** Square side in px: 24 (in a header line), 28 (beside a field), 36 (the rail), 40 (a thumb). */
  size?: 24 | 28 | 36 | 40;
  tone?: Tone;
  /** Keep the hairline (a standalone glyph button, not one in a header line). */
  hairline?: boolean;
  /** Destroys something: goes red on hover. */
  danger?: boolean;
  children: ReactNode;
}

/** A glyph in a square, no hairline until hovered. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ label, size = 28, tone = "quiet", hairline, danger, className, style, type = "button", title, ...rest }, ref) {
  return <button ref={ref} type={type} aria-label={label} title={title ?? label} className={cx("loki-btn", !hairline && "loki-btn--bare", "loki-btn--icon", BTN_TONE[tone], danger && "loki-btn--danger", className)} style={{ width: size, height: size, ...style }} {...rest} />;
});

/** A page down the left of Settings or Agents; `current` marks the one showing. */
export function NavButton({ current, className, type = "button", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { current: boolean }) {
  return <button type={type} aria-current={current ? "page" : undefined} className={cx("loki-nav", className)} {...rest} />;
}

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** The button, for a host that hands focus back to it (the model pill). */
  ref?: Ref<HTMLButtonElement>;
  /** Neutral when chosen. */
  active?: boolean;
  /** The blue pick: accent ink on a blue wash (a chosen agent, an open permission mode). */
  brass?: boolean;
  /** Needs you: the red filled badge (unread, waiting counts). */
  attention?: boolean;
  /** A status colour of its own (a token), for badges. */
  tone?: string;
  /** Reads only: renders a span, no hover. */
  static?: boolean;
  touch?: boolean;
  /** A name chip: a touch bolder (was condensed caps until 2026-09-23). */
  label?: boolean;
  /** Floating over content: opaque, low shadow. */
  float?: boolean;
  /** A tag inside a meta line: as tall as the line. */
  tag?: boolean;
}

/** A pill: a filter, a choice, a badge. Sans 12. */
export function Chip({ active, brass, attention, tone, static: isStatic, touch, label, float, tag, className, style, children, type = "button", ...rest }: ChipProps) {
  const cls = cx("loki-chip", active && "loki-chip--active", brass && "loki-chip--brass", attention && "loki-chip--attention", tone && "loki-chip--tone", (isStatic || tone) && "loki-chip--static", touch && "loki-chip--touch", label && "loki-chip--label", float && "loki-chip--float", tag && "loki-chip--tag", className);
  const st = tone ? ({ "--chip-tone": tone, ...style } as CSSProperties) : style;
  if (isStatic || tone) {
    const { onClick: _onClick, disabled: _disabled, ...span } = rest as ButtonHTMLAttributes<HTMLButtonElement>;
    return <span className={cls} style={st} {...(span as HTMLAttributes<HTMLSpanElement>)}>{children}</span>;
  }
  return <button type={type} className={cls} style={st} {...rest}>{children}</button>;
}

type FieldMods = {
  /** sm 28 · md 32 (default) · touch 44 with 15px type. */
  size?: Size;
  mono?: boolean;
  /** The first line of a sheet: no box, a hairline below. */
  bare?: boolean;
  /** 15px type for a title line. */
  large?: boolean;
  /** Editable text that shows its box on hover and focus. */
  inline?: boolean;
};
const FIELD_SIZE: Record<Size, string | null> = { sm: "loki-field--sm", md: null, touch: "loki-field--touch" };
const fieldClass = ({ size = "md", mono, bare, large, inline }: FieldMods, className?: string) => cx("loki-field", FIELD_SIZE[size], mono && "loki-field--mono", bare && "loki-field--bare", large && "loki-field--title", inline && "loki-field--inline", className);

/** `size` is ours (the native character-count attribute is never used here). */
export type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & FieldMods;
/** A text input on the well. */
export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field({ size, mono, bare, large, inline, className, ...rest }, ref) {
  return <input ref={ref} className={fieldClass({ size, mono, bare, large, inline }, className)} {...rest} />;
});

export type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & FieldMods;
/** A textarea on the well; never resizable by hand (the layout owns its height). */
export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea({ size, mono, bare, large, inline, className, ...rest }, ref) {
  return <textarea ref={ref} className={fieldClass({ size, mono, bare, large, inline }, className)} {...rest} />;
});

export interface RowProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  selected?: boolean;
  /** 6px radius, tighter padding: options in a picker. */
  dense?: boolean;
  touch?: boolean;
  /** One of several inside a bordered group: square, a hairline between neighbours. */
  flush?: boolean;
}

/** A pickable line in a list. Neutral tints on hover and when selected; never the accent or the badge. */
export const Row = forwardRef<HTMLButtonElement, RowProps>(function Row({ selected, dense, touch, flush, className, type = "button", ...rest }, ref) {
  return <button ref={ref} type={type} data-selected={selected || undefined} className={cx("loki-row", dense && "loki-row--dense", touch && "loki-row--touch", flush && "loki-row--flush", className)} {...rest} />;
});

export interface SheetProps {
  /** The dialog's accessible name. */
  label: string;
  /** Escape and a click on the veil call this; leave it out for a sheet that cannot be dismissed (Welcome). */
  onClose?: () => void;
  /** Pixels, or any CSS length ("min(1000px, 92vw)" for Preferences). */
  width?: number | string;
  /** A fixed height (any CSS length), for a sheet laid out as a window rather than grown by its content; it also lifts the 84vh cap. */
  height?: number | string;
  /** Distance from the top of the window; "bottom" docks the sheet to the bottom edge (the phone). */
  top?: string;
  placement?: "top" | "bottom";
  /** Let a tall sheet scroll the veil instead of clipping (Welcome). */
  scroll?: boolean;
  /** Stacking; LAYER.modal unless it can open over another sheet. */
  zIndex?: number;
  /** Escape closes by default; pass false when the sheet handles keys itself. */
  escape?: boolean;
  className?: string;
  style?: CSSProperties;
  cardProps?: HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, unknown>;
  children: ReactNode;
}

/**
 * A modal sheet over a veil: aria-modal, Escape and a click on the veil close it, and focus returns to
 * where it was when the sheet closes. (A Tab loop inside the sheet is the next step; see docs/design.md.)
 */
export function Sheet({ label, onClose, width = 560, height, top, placement = "top", scroll, zIndex = LAYER.modal, escape = !!onClose, className, style, cardProps, children }: SheetProps) {
  const opener = useRef<Element | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    opener.current = document.activeElement;
    // Focus lands inside: on the control that asked for it, else the first one, else the card itself.
    const card = cardRef.current;
    if (card && !card.contains(document.activeElement)) {
      const first = card.querySelector<HTMLElement>("[autofocus]") ?? card.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? card).focus();
    }
    return () => {
      const el = opener.current;
      if (el instanceof HTMLElement && document.contains(el)) el.focus();
    };
  }, []);
  return (
    <div
      className={cx("loki-veil", scroll && "loki-veil--scroll", placement === "bottom" && "loki-veil--bottom")}
      data-sheet
      style={{ zIndex, ...(top ? ({ "--sheet-top": top } as CSSProperties) : null) }}
      onPointerDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose?.();
      }}
      onKeyDown={(e) => {
        if (escape && onClose && e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        } else if (e.key === "Tab" && !e.defaultPrevented) {
          // Focus stays inside the sheet: from the last control Tab wraps to the first, and back.
          const card = cardRef.current;
          if (!card) return;
          const stops = [...card.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hasAttribute("disabled") && el.tabIndex >= 0 && el.getClientRects().length > 0);
          if (stops.length === 0) return;
          const first = stops[0];
          const last = stops[stops.length - 1];
          const active = document.activeElement;
          if (e.shiftKey && (active === first || active === card)) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && active === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }}
    >
      <div ref={cardRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={label} className={cx("loki-sheet", "loki-sheet-card", placement === "bottom" && "loki-sheet-card--bottom", className)} style={{ width: placement === "bottom" ? undefined : width, ...(height !== undefined ? { height, maxHeight: "none" } : null), ...style }} {...cardProps}>
        {children}
      </div>
    </div>
  );
}

export interface PopoverProps extends HTMLAttributes<HTMLDivElement> {
  /** Which edge of the anchor it hangs from. */
  anchor?: "left" | "right";
  /** Below the anchor line (the default) or above it, for chips along a panel's bottom. */
  side?: "below" | "above";
  width?: number;
}

/** A small panel hung from a line of chips: the model picker, the mode menu. Stacks inside its component. */
export const Popover = forwardRef<HTMLDivElement, PopoverProps>(function Popover({ anchor = "left", side = "below", width = 320, className, style, onPointerDown, ...rest }, ref) {
  return (
    <div
      ref={ref}
      className={cx("loki-popover", side === "above" && "loki-popover--above", className)}
      style={{ [anchor]: 8, width, ...style }}
      onPointerDown={(e) => {
        e.stopPropagation();
        onPointerDown?.(e);
      }}
      {...rest}
    />
  );
});

/** A shortcut hint: mono (keys are data), muted, hairlined. */
export function Kbd({ children, className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span aria-hidden className={cx("loki-kbd", className)} {...rest}>{children}</span>;
}

/** Meta: agent, time, model — sans 12, muted. `brass` (kept name) tints it the accent blue, `negative` the red ink for a small error; `wrap` for a sentence. */
export function Meta({ brass, negative, wrap, className, ...rest }: HTMLAttributes<HTMLSpanElement> & { brass?: boolean; negative?: boolean; wrap?: boolean }) {
  return <span className={cx("loki-meta", brass && "loki-meta--brass", negative && "loki-meta--negative", wrap && "loki-meta--wrap", className)} {...rest} />;
}

/** A section's title: sans bold 17; `page` for the one title on a view (22). */
export function Title({ page, className, ...rest }: HTMLAttributes<HTMLDivElement> & { page?: boolean }) {
  return <div className={cx("loki-title", page && "loki-title--page", className)} {...rest} />;
}

/** The status dot, coloured by the caller: attention red filled waits on you, a ring finished unread, muted ring running, negative failed. */
export function Dot({ size = 6, color, ring, pulse, halo, className, style, ...rest }: HTMLAttributes<HTMLSpanElement> & { size?: number; color: string; ring?: boolean; pulse?: boolean; /** A panel-coloured ring, to sit on an icon. */ halo?: boolean }) {
  return <span className={cx("loki-dot", pulse && "loki-pulse", halo && "loki-dot--halo", className)} style={{ width: size, height: size, background: ring ? "transparent" : color, border: `1px solid ${color}`, ...style }} {...rest} />;
}

/** Nothing here yet, said usefully: a title, a line that says what would put something here, an action. */
export function Empty({ title, children, card, className, ...rest }: HTMLAttributes<HTMLDivElement> & { title: ReactNode; card?: boolean }) {
  return (
    <div className={cx("loki-empty", card && "loki-empty--card", className)} {...rest}>
      <Title>{title}</Title>
      {children}
    </div>
  );
}

/** A line across the top of a surface: the Mac is unreachable, an update is ready. Tone is a dot, not a stripe. */
export function Banner({ tone = "var(--loki-negative)", children, className, ...rest }: HTMLAttributes<HTMLDivElement> & { tone?: string }) {
  return (
    <div role="status" className={cx("loki-banner", className)} {...rest}>
      <Dot color={tone} />
      <span style={{ minWidth: 0 }}>{children}</span>
    </div>
  );
}

/** A notice, briefly, at the bottom centre of the window. */
export function Toast({ children, className, style, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div role="status" className={cx("loki-toast", className)} style={{ zIndex: LAYER.toast, boxShadow: "var(--loki-shadow-float)", ...style }} {...rest}>{children}</div>;
}

/** An on/off switch with its label: Settings › phone (the listener), Settings › keys (⌥Space). */
export function Switch({ on, onToggle, label, small = false }: { on: boolean; onToggle: () => void; label: string; small?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={onToggle} style={{ display: "inline-flex", alignItems: "center", gap: 8, background: "transparent", border: "none", padding: 0, cursor: "pointer", color: on ? "var(--loki-fg)" : "var(--loki-muted)", fontSize: small ? 12 : 13.5 }}>
      <span aria-hidden style={{ width: 28, height: 16, borderRadius: "var(--loki-radius-pill)", background: on ? "var(--loki-accent)" : "var(--loki-control-border)", position: "relative", transition: "background 160ms ease-out", flex: "0 0 auto" }}>
        <span style={{ position: "absolute", top: 2, left: on ? 14 : 2, width: 12, height: 12, borderRadius: "var(--loki-radius-sm)", background: on ? "var(--loki-bg)" : "var(--loki-muted)", transition: "left 160ms ease-out" }} />
      </span>
      {label}
    </button>
  );
}

// ---- Slack building blocks (plan 013) ---------------------------------------------------------------

/** "99+" past two digits, as the rail's and the phone's badges do. */
export const countText = (n: number): string => (n > 99 ? "99+" : String(n));

/**
 * A row's state in words, for the screen reader and for anyone who cannot tell the red badge or the bold
 * title apart: "unread, 3 waiting, working". A `note` says more than "unread" and takes its place ("viewed, not done").
 * Empty when there is nothing to say.
 */
export function rowStatus({ unread, badge, badgeNoun = "waiting", live, note }: { unread?: boolean; badge?: number | null; badgeNoun?: string; live?: boolean; note?: string }): string {
  return [note || (unread && "unread"), badge != null && badge > 0 && `${countText(badge)} ${badgeNoun}`, live && "working"].filter(Boolean).join(", ");
}

/** An icon in the avatar's place: the # before a desk, the archive box. */
export function ListIcon({ name }: { name: IconName }) {
  return (
    <span aria-hidden className="loki-list-icon">
      <Icon name={name} size={16} />
    </span>
  );
}

export interface ListRowProps {
  /** The start: an agent's face (AgentFace at 20) or a ListIcon. */
  lead?: ReactNode;
  title: ReactNode;
  /** One muted line under the title. Sidebar rows leave it out; list-and-detail lists (agents, board, learn) use it. */
  preview?: ReactNode;
  /** Quiet text on the right ("3h"); the badge takes its place when there is one. */
  time?: string | null;
  /** Needs you: a red count pill when above zero. */
  badge?: number | null;
  /** What the count counts, in words ("3 waiting"). */
  badgeNoun?: string;
  /** Bold title in full ink: something in it is new. */
  unread?: boolean;
  /** Words for the row's reading that say more than "unread" and replace it (the desk sidebar: "viewed, not done"). */
  note?: string;
  /** The agent is working: a green dot at the lead's corner (or before the title) and "working" in words. */
  live?: boolean;
  /** The row whose detail is open (aria-current="page"). */
  current?: boolean;
  /** Drawn quieter: an archived desk. */
  dim?: boolean;
  /** Small marks after the title, e.g. the pin. */
  flags?: ReactNode;
  /** The row button's accessible name; the visible text and the status words when omitted. */
  label?: string;
  onOpen: () => void;
  /** A right-click or the context-menu key: the row's menu (pin, archive…). */
  onMenu?: (e: MouseEvent<HTMLButtonElement>) => void;
  /** Buttons at the right edge, shown while the row is hovered or holds focus (Slack's row actions). */
  actions?: ReactNode;
  /** `data-launch`, so a caller can hand focus back to this row. */
  launch?: string;
}

/**
 * One row of a desktop list, Slack's anatomy: the lead, the title (bold when unread) over an optional
 * preview, and on the right the time or the red badge. The whole row is one button; `actions` sit beside
 * it, not inside, so they are their own tab stops. Goes inside a ListSection or a `<ul className="loki-list">`.
 */
export function ListRow({ lead, title, preview, time, badge, badgeNoun, unread = false, note, live = false, current = false, dim = false, flags, label, onOpen, onMenu, actions, launch }: ListRowProps) {
  const count = badge != null && badge > 0 ? badge : null;
  const status = rowStatus({ unread, badge: count, badgeNoun, live, note });
  const liveDot = live ? <span aria-hidden className="loki-list-row-live" /> : null;
  return (
    <li className="loki-list-item" data-dim={dim || undefined} data-current={current || undefined}>
      <button
        type="button"
        className={cx("loki-list-row", unread && "loki-list-row--unread")}
        aria-current={current ? "page" : undefined}
        aria-label={label}
        data-launch={launch}
        onClick={onOpen}
        onContextMenu={
          onMenu
            ? (e) => {
                e.preventDefault();
                onMenu(e);
              }
            : undefined
        }
      >
        {lead ? (
          <span className="loki-list-row-lead">
            {lead}
            {liveDot}
          </span>
        ) : (
          liveDot
        )}
        <span className="loki-list-row-copy">
          <span className="loki-list-row-title">
            <span className="loki-list-row-name">{title}</span>
            {flags}
          </span>
          {preview && <span className="loki-list-row-preview">{preview}</span>}
        </span>
        {status && <span className="sr-only">{status}</span>}
        {count !== null ? (
          <span className="loki-list-badge" aria-hidden>
            {countText(count)}
          </span>
        ) : time ? (
          <span className="loki-list-row-time">{time}</span>
        ) : null}
      </button>
      {actions && <span className="loki-list-row-actions">{actions}</span>}
    </li>
  );
}

/**
 * A sidebar section, Slack's: a chevron that folds it (`open` + `onToggle`), an optional icon, the title, a
 * quiet count, and header actions on the right (new desk, a section menu). Folded, the list is not rendered
 * and the toggle says so with aria-expanded. Without `onToggle` the heading is plain text.
 */
export function ListSection({ title, icon, count, open = true, onToggle, actions, children }: { title: string; icon?: IconName; count?: number | null; open?: boolean; onToggle?: () => void; actions?: ReactNode; children?: ReactNode }) {
  const inner = (
    <>
      {onToggle && <Icon name="chevron-down" size={12} className={cx("loki-list-section-chev", !open && "loki-list-section-chev--folded")} />}
      {icon && <Icon name={icon} size={14} />}
      <span className="loki-list-section-title">{title}</span>
      {count != null && count > 0 && <span className="loki-list-section-count">{countText(count)}</span>}
    </>
  );
  return (
    <section className="loki-list-section" aria-label={title}>
      <div className="loki-list-section-head">
        <h2 className="loki-list-section-heading">
          {onToggle ? (
            <button type="button" className="loki-list-section-toggle" aria-expanded={open} onClick={onToggle}>
              {inner}
            </button>
          ) : (
            <span className="loki-list-section-toggle">{inner}</span>
          )}
        </h2>
        {actions && <span className="loki-list-section-actions">{actions}</span>}
      </div>
      {open && children && <ul className="loki-list">{children}</ul>}
    </section>
  );
}

/** One tab of a TabRow. */
export interface Tab<T extends string = string> {
  id: T;
  label: string;
  icon?: IconName;
  /** A quiet count after the label (files, cards). */
  count?: number | null;
}

/**
 * A row of tabs under a pane header, Slack's Messages | Canvas | Files: the chosen one in full ink over a
 * 2px rule. An ARIA tablist with a roving tab stop: Tab lands on the chosen tab, the arrow keys, Home and
 * End move and choose. `panelId` names the panel each tab controls, when the host gives it an id.
 */
export function TabRow<T extends string>({ label, tabs, current, onChange, panelId }: { label: string; tabs: readonly Tab<T>[]; current: T; onChange: (id: T) => void; panelId?: (id: T) => string }) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = tabs.findIndex((t) => t.id === current);
    const to = e.key === "ArrowRight" ? at + 1 : e.key === "ArrowLeft" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
    if (to === null || tabs.length === 0) return;
    e.preventDefault();
    const next = tabs[(to + tabs.length) % tabs.length];
    onChange(next.id);
    e.currentTarget.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className="loki-tabs" onKeyDown={onKeyDown}>
      {tabs.map((t) => {
        const on = t.id === current;
        return (
          <button key={t.id} type="button" role="tab" data-tab={t.id} aria-selected={on} tabIndex={on ? 0 : -1} aria-controls={panelId?.(t.id)} className="loki-tab" onClick={() => onChange(t.id)}>
            {t.icon && <Icon name={t.icon} size={14} />}
            {t.label}
            {t.count != null && t.count > 0 && <span className="loki-tab-count">{countText(t.count)}</span>}
          </button>
        );
      })}
    </div>
  );
}

export interface PaneHeaderProps<T extends string = string> {
  title: ReactNode;
  /** Before the title: a # icon or the agent's face. */
  lead?: ReactNode;
  /** A quiet line beside the title: the agent and its live state. */
  aside?: ReactNode;
  /** On the right: the pane's actions (IconButtons, a menu). */
  actions?: ReactNode;
  /** The tab row under the line; omitted, the header is one line. */
  tabs?: readonly Tab<T>[];
  tab?: T;
  onTab?: (id: T) => void;
  /** The tablist's name, e.g. "Desk views". */
  tabsLabel?: string;
  panelId?: (id: T) => string;
  /** The title's id, so the pane can be labelled by it. */
  titleId?: string;
}

/** The main pane's header, Slack's: the name, a quiet aside and the actions on one line, the tab row under it. */
export function PaneHeader<T extends string>({ title, lead, aside, actions, tabs, tab, onTab, tabsLabel = "Views", panelId, titleId }: PaneHeaderProps<T>) {
  return (
    <header className="loki-pane-header">
      {/* The name line drags the window in the app (the native title bar is hidden); its buttons still click. */}
      <div className="loki-pane-header-line" data-tauri-drag-region="deep">
        {lead && <span className="loki-pane-header-lead">{lead}</span>}
        <h1 id={titleId} className="loki-pane-title">
          {title}
        </h1>
        {aside && <span className="loki-meta loki-pane-header-aside">{aside}</span>}
        {actions && <span className="loki-pane-header-actions">{actions}</span>}
      </div>
      {tabs && tab !== undefined && onTab && <TabRow label={tabsLabel} tabs={tabs} current={tab} onChange={onTab} panelId={panelId} />}
    </header>
  );
}

/** A pane with nothing chosen or nothing in it: centred in the space, an optional icon over the Empty title and line. */
export function EmptyPane({ icon, title, children, className, ...rest }: HTMLAttributes<HTMLDivElement> & { icon?: IconName; title: ReactNode }) {
  return (
    <div className={cx("loki-empty-pane", className)} {...rest}>
      <div className="loki-empty">
        {icon && <Icon name={icon} size={28} className="loki-empty-pane-icon" />}
        <Title>{title}</Title>
        {children}
      </div>
    </div>
  );
}
