import type { ButtonHTMLAttributes, CSSProperties, HTMLAttributes, MouseEvent, ReactNode, Ref } from "react";
import { cloneElement, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useSheetMotion } from "./sheet-motion";
import { LAYER } from "../kit/layers";
import { capitalChildren } from "../kit/words";
import { FOCUSABLE, assignRef, cx, firstControl } from "./parts";
import type { ButtonProps, ChipProps, IconButtonProps, PopoverProps, SheetProps, Size, Tone } from "./index";

/**
 * The phone's own markup for the primitives (plan 2026-11-15-2330, KTD1): coloured text on a hairline, phone.css's
 * restyle of it, the bottom sheet that moves as an iOS sheet does. index.tsx draws shadcn's controls on the desktop and
 * hands the phone, or a touch-sized control anywhere, to these.
 */

const BTN_SIZE: Record<Size, string> = { sm: "loki-btn--sm", md: "loki-btn--md", touch: "loki-btn--touch" };
const BTN_TONE: Record<Tone, string | null> = {
  quiet: null,
  paper: "loki-btn--paper",
  brass: "loki-btn--brass",
  positive: "loki-btn--positive",
  negative: "loki-btn--negative",
};

/** The phone's button: coloured text on a hairline, its key in the tooltip and `aria-keyshortcuts` as the desktop's. */
export function PhoneButton({
  tone = "quiet",
  size = "sm",
  bare,
  block,
  className,
  children,
  ref,
  ...rest
}: Omit<ButtonProps, "kbd"> & { ref?: Ref<HTMLButtonElement> }) {
  return (
    <button ref={ref} className={cx("loki-btn", BTN_SIZE[size], BTN_TONE[tone], bare && "loki-btn--bare", block && "loki-btn--block", className)} {...rest}>
      {capitalChildren(children)}
    </button>
  );
}

/** The phone's glyph button: bare unless `hairline`, red on press when it destroys something. */
export function PhoneIconButton({
  label,
  size = 28,
  tone = "quiet",
  hairline,
  danger,
  className,
  style,
  title,
  ref,
  ...rest
}: IconButtonProps & { ref?: Ref<HTMLButtonElement> }) {
  return (
    <button
      ref={ref}
      aria-label={label}
      title={title ?? label}
      className={cx("loki-btn", !hairline && "loki-btn--bare", "loki-btn--icon", BTN_TONE[tone], danger && "loki-btn--danger", className)}
      style={{ width: size, height: size, ...style }}
      {...rest}
    />
  );
}

/** The phone's pill, and a touch-sized one anywhere: a button, or a span when it only reads. */
export function PhoneChip({
  active,
  brass,
  attention,
  tone,
  static: isStatic,
  touch,
  label,
  float,
  tag,
  className,
  style,
  children,
  type = "button",
  ...rest
}: ChipProps) {
  const cls = cx(
    "loki-chip",
    active && "loki-chip--active",
    brass && "loki-chip--brass",
    attention && "loki-chip--attention",
    tone && "loki-chip--tone",
    (isStatic || tone) && "loki-chip--static",
    touch && "loki-chip--touch",
    label && "loki-chip--label",
    float && "loki-chip--float",
    tag && "loki-chip--tag",
    className,
  );
  const st = tone ? ({ "--chip-tone": tone, ...style } as CSSProperties) : style;
  if (isStatic || tone) {
    const { onClick: _onClick, disabled: _disabled, ...span } = rest as ButtonHTMLAttributes<HTMLButtonElement>;
    return (
      <span className={cls} style={st} {...span}>
        {children}
      </span>
    );
  }
  return (
    <button type={type} className={cls} style={st} {...rest}>
      {children}
    </button>
  );
}

/** The phone's on/off switch with its label: a small track and thumb drawn inline. */
export function PhoneSwitch({
  on,
  onToggle,
  label,
  small,
  hideLabel,
}: {
  on: boolean;
  onToggle: () => void;
  label: string;
  small: boolean;
  hideLabel: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={hideLabel ? label : undefined}
      onClick={onToggle}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        background: "transparent",
        border: "none",
        padding: 0,
        cursor: "pointer",
        color: on ? "var(--loki-fg)" : "var(--loki-muted)",
        fontSize: small ? "var(--text-xs)" : "var(--text-sm)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 28,
          height: 16,
          borderRadius: "var(--loki-radius-pill)",
          background: on ? "var(--loki-accent)" : "var(--loki-control-border)",
          position: "relative",
          transition: "background 160ms ease-out",
          flex: "0 0 auto",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            left: 2,
            width: 12,
            height: 12,
            borderRadius: "var(--radius-md)",
            background: on ? "var(--loki-bg)" : "var(--loki-muted)",
            transform: on ? "translateX(12px)" : "none",
            transition: "transform 160ms ease-out, background-color 160ms ease-out",
          }}
        />
      </span>
      {!hideLabel && label}
    </button>
  );
}

/**
 * The phone's popover (plan 2026-11-15-2130, KTD2): its control, then, when open, a panel placed beside it in the
 * control's wrapper. `grows` says whether a click opened it, so it grows out of the corner it hangs from.
 */
export function PhonePopover({
  trigger,
  open,
  onOpenChange,
  anchor = "left",
  side = "below",
  width = 320,
  initialFocus,
  touch: _touch,
  ref,
  className,
  style,
  grows,
  ...rest
}: PopoverProps & { grows: boolean }) {
  return (
    <>
      {cloneElement(trigger, {
        "aria-haspopup": rest.role,
        "aria-expanded": open,
        onClick: (e: MouseEvent<HTMLButtonElement>) => {
          trigger.props.onClick?.(e);
          onOpenChange(!open);
        },
      })}
      {open && (
        <PopoverPanel
          panelRef={ref}
          onClose={() => onOpenChange(false)}
          initialFocus={initialFocus}
          className={cx("loki-popover", side === "above" && "loki-popover--above", className)}
          data-grow={grows || undefined}
          style={{ [anchor]: 8, width, transformOrigin: `${side === "above" ? "bottom" : "top"} ${anchor}`, ...style }}
          {...rest}
        />
      )}
    </>
  );
}

/**
 * The phone popover's panel: absolutely placed in the control's wrapper. A press outside the wrapper or Esc closes it,
 * and focus goes back to the control unless what was picked took it elsewhere.
 */
function PopoverPanel({
  panelRef,
  onClose,
  initialFocus,
  onKeyDown,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { panelRef?: Ref<HTMLDivElement>; onClose: () => void; initialFocus?: () => HTMLElement | null | undefined }) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef({ onClose, initialFocus });
  useEffect(() => {
    latest.current = { onClose, initialFocus };
  });
  useEffect(() => {
    const node = ref.current;
    const wrapper = node?.parentElement ?? null;
    latest.current.initialFocus?.()?.focus({ preventScroll: true });
    // Capture phase: panes and other popovers stop pointerdown from bubbling, and a press there must still close it.
    const away = (e: PointerEvent) => {
      if (e.target instanceof Node && !wrapper?.contains(e.target)) latest.current.onClose();
    };
    window.addEventListener("pointerdown", away, true);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      const a = document.activeElement;
      if (!a || a === document.body || node?.contains(a)) wrapper?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div
      ref={(el) => {
        ref.current = el;
        assignRef(panelRef, el);
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.defaultPrevented || e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
      {...rest}
    />
  );
}

/**
 * The phone's bottom sheet over a veil: aria-modal, Escape and a click on the veil close it, focus stays inside and
 * returns to where it was when the sheet closes, and it moves as an iOS sheet does (sheet-motion.ts). It is drawn at
 * the phone shell's root, above the screen it covers, so that screen can recede under it.
 */
export function BottomSheet({ label, onClose, zIndex = LAYER.modal, escape = !!onClose, className, style, cardProps, children }: SheetProps) {
  const opener = useRef<Element | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const veilRef = useRef<HTMLDivElement>(null);
  const shell = typeof document !== "undefined" ? document.querySelector<HTMLElement>(".loki-phone-shell") : null;
  useSheetMotion(veilRef, cardRef, onClose, !!shell);
  useEffect(() => {
    opener.current = document.activeElement;
    // Focus lands inside: on the control that asked for it, else the first one, else the card itself.
    const card = cardRef.current;
    // Without preventScroll the browser scrolls the rising sheet's first row into view: on the phone that
    // scrolled the whole shell up under the sheet and back, so the sheet seemed to open twice.
    if (card && !card.contains(document.activeElement)) (firstControl(card) ?? card).focus({ preventScroll: true });
    return () => {
      const el = opener.current;
      if (el instanceof HTMLElement && document.contains(el)) el.focus({ preventScroll: true });
    };
  }, []);
  const sheet: ReactNode = (
    <div
      ref={veilRef}
      className="loki-veil loki-veil--bottom"
      data-sheet
      // On the phone the finger is what opened it: a bottom sheet always rises.
      data-grow
      style={{ zIndex }}
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
          const stops = [...card.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
            (el) => !el.hasAttribute("disabled") && el.tabIndex >= 0 && el.getClientRects().length > 0,
          );
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
      <div
        ref={cardRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        data-grow
        className={cx("loki-sheet", "loki-sheet-card", "loki-sheet-card--bottom", className)}
        style={style}
        {...cardProps}
      >
        {children}
      </div>
    </div>
  );
  return shell ? createPortal(sheet, shell) : sheet;
}
