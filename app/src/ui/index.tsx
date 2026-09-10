import type { ButtonHTMLAttributes, CSSProperties, HTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";
import { forwardRef, useEffect, useRef } from "react";
import { LAYER } from "../kit/layers";

/**
 * The app's primitives: the one Button, Chip, Field, Row, Sheet, Popover and the small text pieces.
 * States (hover, focus, active, disabled, pressed, current) live in ui/ui.css; a call site chooses a size
 * and a tone and never restyles a state. `className` and `style` are the escape hatch for a one-off, and
 * a one-off that repeats becomes a modifier here. Widgets on the sheet keep their own kit (kit/index.tsx).
 */

export type Tone = "quiet" | "paper" | "brass" | "positive" | "negative";
export type Size = "sm" | "md" | "touch";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");
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

/** The button. Coloured text on a hairline; the tone says who it is for (brass: the human is needed). */
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
  /** Destroys something: goes oxblood on hover. */
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
  /** paper when chosen; brass only when the chip itself needs the human. */
  active?: boolean;
  brass?: boolean;
  /** A status colour of its own (a token), for badges. */
  tone?: string;
  /** Reads only: renders a span, no hover. */
  static?: boolean;
  touch?: boolean;
  /** Condensed caps instead of mono. */
  label?: boolean;
  /** Floating over content: opaque, low shadow. */
  float?: boolean;
  /** A tag inside a meta line: as tall as the line. */
  tag?: boolean;
}

/** A pill: a filter, a choice, a badge. Mono 10.5 tracked by default. */
export function Chip({ active, brass, tone, static: isStatic, touch, label, float, tag, className, style, children, type = "button", ...rest }: ChipProps) {
  const cls = cx("loki-chip", active && "loki-chip--active", brass && "loki-chip--brass", tone && "loki-chip--tone", (isStatic || tone) && "loki-chip--static", touch && "loki-chip--touch", label && "loki-chip--label", float && "loki-chip--float", tag && "loki-chip--tag", className);
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

/** A pickable line in a list. The header tint on hover and when selected; brass never. */
export const Row = forwardRef<HTMLButtonElement, RowProps>(function Row({ selected, dense, touch, flush, className, type = "button", ...rest }, ref) {
  return <button ref={ref} type={type} data-selected={selected || undefined} className={cx("loki-row", dense && "loki-row--dense", touch && "loki-row--touch", flush && "loki-row--flush", className)} {...rest} />;
});

export interface SheetProps {
  /** The dialog's accessible name. */
  label: string;
  /** Escape and a click on the veil call this; leave it out for a sheet that cannot be dismissed (Welcome). */
  onClose?: () => void;
  width?: number;
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
export function Sheet({ label, onClose, width = 560, top, placement = "top", scroll, zIndex = LAYER.modal, escape = !!onClose, className, style, cardProps, children }: SheetProps) {
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
      <div ref={cardRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={label} className={cx("loki-sheet", "loki-sheet-card", placement === "bottom" && "loki-sheet-card--bottom", className)} style={{ width: placement === "bottom" ? undefined : width, ...style }} {...cardProps}>
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

/** A shortcut hint: mono, muted, hairlined. */
export function Kbd({ children, className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span aria-hidden className={cx("loki-kbd", className)} {...rest}>{children}</span>;
}

/** Mono meta: agent, time, model — 10.5, tracked, muted. `brass` when the line needs the human; `wrap` for a sentence. */
export function Meta({ brass, wrap, className, ...rest }: HTMLAttributes<HTMLSpanElement> & { brass?: boolean; wrap?: boolean }) {
  return <span className={cx("loki-meta", brass && "loki-meta--brass", wrap && "loki-meta--wrap", className)} {...rest} />;
}

/** A section's title in the display face (17); `page` for the one title on a view (22). */
export function Title({ page, className, ...rest }: HTMLAttributes<HTMLDivElement> & { page?: boolean }) {
  return <div className={cx("loki-title", page && "loki-title--page", className)} {...rest} />;
}

/** The status dot: brass filled waits on you, a ring finished unread, muted ring running, oxblood failed. */
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
      <span aria-hidden style={{ width: 28, height: 16, borderRadius: 999, background: on ? "var(--loki-accent)" : "var(--loki-border)", position: "relative", transition: "background 160ms ease-out", flex: "0 0 auto" }}>
        <span style={{ position: "absolute", top: 2, left: on ? 14 : 2, width: 12, height: 12, borderRadius: 6, background: on ? "var(--loki-bg)" : "var(--loki-muted)", transition: "left 160ms ease-out" }} />
      </span>
      {label}
    </button>
  );
}
