import type {
  ButtonHTMLAttributes,
  CSSProperties,
  HTMLAttributes,
  InputHTMLAttributes,
  KeyboardEvent,
  MouseEvent,
  ReactElement,
  ReactNode,
  Ref,
  TextareaHTMLAttributes,
} from "react";
import { forwardRef, useRef, useState } from "react";
import { Toaster, toast } from "sonner";
import { cx, firstControl } from "./parts";
import { BottomSheet, PhoneButton, PhoneChip, PhoneIconButton, PhonePopover, PhoneSwitch } from "./phone";
import { LAYER } from "../kit/layers";
import { useLeave } from "../kit/leave";
import { lastInput } from "../kit/motion";
import { Icon, type IconName } from "../shared/icons";
import { capitalChildren, capitalFirst } from "../kit/words";
import { ariaShortcut } from "../shell/keymap";
import { inLan } from "../desk/env";
import { Button as UiButton } from "@/ui/button";
import { Switch as UiSwitch } from "@/ui/switch";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/ui/input-group";
import { Badge } from "@/ui/badge";
import { Popover as UiPopover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Tabs, TabsList, TabsTrigger } from "@/ui/tabs";
import { Dialog, DialogOverlay, DialogPopup, DialogPortal, DialogViewport } from "@/ui/dialog";
import { SearchIcon } from "lucide-react";

/**
 * The app's primitives: the one Button, Chip, Field, Row, Sheet, Popover and the small text pieces, and the
 * desktop's Slack building blocks (ListRow, ListSection, PaneHeader with its TabRow, EmptyPane).
 * States (hover, focus, active, disabled, pressed, current) live in components/components.css; a call site chooses a size
 * and a tone and never restyles a state. `className` and `style` are the escape hatch for a one-off, and
 * a one-off that repeats becomes a modifier here. Widgets on the sheet keep their own kit (kit/index.tsx).
 * The desktop draws shadcn's controls here; the phone's own markup for them lives in phone.tsx (plan 2026-11-15-2330).
 */

/**
 * Button tones. The names predate the Slack direction (2026-09-23) and are kept for compatibility:
 * quiet muted ink · paper fg ink · brass the interactive blue (accent ink on a hairline) · positive Slack's
 * green affirmative, filled · negative red ink. "Needs you" is the red attention badge, not a tone.
 */
export type Tone = "quiet" | "paper" | "brass" | "positive" | "negative";
/** Control heights: sm 28px (the desktop's default), md 36px, touch 44px (the phone). */
export type Size = "sm" | "md" | "touch";

/** Sentence case for a label built from an id ("inbox" → "Inbox"); labels are shown as written, never transformed. */
export const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The props of `Button`: the native button's, with a tone, a size, and the hairline, width and shortcut hint options. */
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

/**
 * The phone keeps loki's own markup and phone.css's restyle of it; the desktop draws shadcn's button in the Mac's kinds
 * (plan 2026-11-15-1035, KTD5). `touch` is the phone's size, so a touch-sized control takes the phone's markup wherever
 * it is drawn.
 */
const phoneMarkup = (size?: Size) => inLan || size === "touch";

/** The Mac's button kind for a tone (plan 2026-11-15-1035, KTD2): push for neutral ink, plain for the blue, the
 * default fill for the affirmative, destructive for red. A bare button has no bezel and keeps its tone's ink. */
const KIND: Record<Tone, "push" | "plain" | "default" | "destructive"> = {
  quiet: "push",
  paper: "push",
  brass: "plain",
  positive: "default",
  negative: "destructive",
};
const BARE_INK: Record<Tone, string> = {
  quiet: "text-muted-foreground",
  paper: "text-foreground",
  brass: "text-loki-accent",
  positive: "text-loki-accent",
  negative: "text-destructive",
};

/**
 * The button. On the desktop, the Mac's push, plain, default and destructive buttons (plan 2026-11-15-1035, U2); on the
 * phone, coloured text on a hairline. Its label takes a capital and its key is in the tooltip, not on the face (plan
 * 2026-11-12-1505, R7 and R10).
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { tone = "quiet", size = "sm", bare, block, kbd, className, children, type = "button", title, ...rest },
  ref,
) {
  const keyTip = kbd != null && typeof kbd === "string" ? kbd : null;
  const tip = keyTip ? `${title ?? (typeof children === "string" ? capitalFirst(children) : "")} (${keyTip})`.trim() : title;
  const shortcut = keyTip ? ariaShortcut(keyTip) : undefined;
  if (phoneMarkup(size))
    return (
      <PhoneButton
        ref={ref}
        type={type}
        tone={tone}
        size={size}
        bare={bare}
        block={block}
        className={className}
        title={tip}
        aria-keyshortcuts={shortcut}
        {...rest}
      >
        {children}
      </PhoneButton>
    );
  const variant = bare && tone !== "positive" ? "ghost" : KIND[tone];
  return (
    <UiButton
      ref={ref}
      type={type}
      variant={variant}
      size={size === "md" ? "default" : "sm"}
      className={cx(bare && tone !== "positive" && BARE_INK[tone], block && "w-full justify-start text-left whitespace-normal", className)}
      title={tip}
      aria-keyshortcuts={shortcut}
      {...rest}
    >
      {capitalChildren(children)}
    </UiButton>
  );
});

/** The props of `IconButton`: a glyph button that needs an accessible label in place of children text. */
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

const ICON_SIZE = { 24: "icon-xs", 28: "icon-sm", 36: "icon", 40: "icon-lg" } as const;

/** A glyph in a square: no bezel until hovered on the desktop, or a push button with `hairline`. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = 28, tone = "quiet", hairline, danger, className, style, type = "button", title, ...rest },
  ref,
) {
  if (inLan)
    return (
      <PhoneIconButton
        ref={ref}
        type={type}
        label={label}
        size={size}
        tone={tone}
        hairline={hairline}
        danger={danger}
        className={className}
        style={style}
        title={title}
        {...rest}
      />
    );
  return (
    <UiButton
      ref={ref}
      type={type}
      aria-label={label}
      title={title ?? label}
      variant={hairline ? "push" : "ghost"}
      size={ICON_SIZE[size]}
      className={cx(!hairline && BARE_INK[tone], danger && "hover:text-destructive", className)}
      style={style}
      {...rest}
    />
  );
});

/** A page down the left of Settings or Agents; `current` marks the one showing. */
export function NavButton({ current, className, type = "button", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { current: boolean }) {
  return <button type={type} aria-current={current ? "page" : undefined} className={cx("loki-nav", className)} {...rest} />;
}

/** The props of `Chip`: the native button's, with the chosen, blue-pick, attention and static looks. */
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

/**
 * A pill: a filter, a choice, a badge. Sans 12. On the desktop it is shadcn's badge in the Mac's capsule (plan
 * 2026-11-15-1035, U2): filled grey with no hairline, the accent fill when chosen, waiting or picked, and a status tone
 * as its ink. The phone, and a touch-sized chip anywhere, draw their own.
 */
export function Chip(props: ChipProps) {
  if (inLan || props.touch) return <PhoneChip {...props} />;
  const { active, brass, attention, tone, static: isStatic, touch: _touch, label, float, tag, className, style, children, type = "button", ...rest } = props;
  const look = cx(
    "h-6 px-2 font-normal",
    (active || brass || attention) && "font-semibold",
    label && "font-semibold",
    tag && "h-auto py-px",
    float && "bg-loki-panel shadow-low",
    !isStatic && !tone && "cursor-pointer hover:brightness-110 disabled:cursor-default disabled:opacity-50",
    className,
  );
  const variant = active || brass || attention ? "default" : "secondary";
  const toned = tone ? { color: tone, ...style } : style;
  if (isStatic || tone) {
    const { onClick: _onClick, disabled: _disabled, ...span } = rest as ButtonHTMLAttributes<HTMLButtonElement>;
    return (
      <Badge variant={variant} className={look} style={toned} {...span}>
        {children}
      </Badge>
    );
  }
  return (
    <Badge variant={variant} className={look} style={toned} render={<button type={type} />} {...rest}>
      {children}
    </Badge>
  );
}

interface FieldMods {
  /** sm 28 · md 32 (default) · touch 44 with 15px type. */
  size?: Size;
  mono?: boolean;
  /** The first line of a sheet: no box, a hairline below. */
  bare?: boolean;
  /** Editable text that shows its box on hover and focus. */
  inline?: boolean;
}
const FIELD_SIZE: Record<Size, string | null> = { sm: "loki-field--sm", md: null, touch: "loki-field--touch" };
const fieldClass = ({ size = "md", mono, bare, inline }: FieldMods, className?: string) =>
  cx("loki-field", FIELD_SIZE[size], mono && "loki-field--mono", bare && "loki-field--bare", inline && "loki-field--inline", className);

/** `size` is ours (the native character-count attribute is never used here). */
export type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & FieldMods;
/**
 * A text input on the well. On the desktop a search field is the Mac's: a filled capsule with the magnifier leading and
 * no border (plan 2026-11-15-1035, R2); `className` and `style` then dress the capsule, and the ref is still the input.
 */
export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field({ size, mono, bare, inline, className, style, ...rest }, ref) {
  if (rest.type === "search" && !inLan && !bare && !inline && size !== "touch")
    return (
      <InputGroup className={cx("h-7 rounded-full border-transparent bg-loki-hover dark:bg-loki-hover", className)} style={style}>
        <InputGroupAddon className="pl-3 text-muted-foreground">
          <SearchIcon aria-hidden className="size-3.5" />
        </InputGroupAddon>
        <InputGroupInput ref={ref} className={cx("text-sm", mono && "font-mono")} {...rest} />
      </InputGroup>
    );
  return <input ref={ref} className={fieldClass({ size, mono, bare, inline }, className)} style={style} {...rest} />;
});

/** The props of `TextArea`: the native textarea's with the field's size and look options. */
export type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & FieldMods;
/** A textarea on the well; never resizable by hand (the layout owns its height). */
export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea({ size, mono, bare, inline, className, ...rest }, ref) {
  return <textarea ref={ref} className={fieldClass({ size, mono, bare, inline }, className)} {...rest} />;
});

/** The props of `Row`: the native button's, with the selected, dense, touch and flush looks. */
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
  return (
    <button
      ref={ref}
      type={type}
      data-selected={selected || undefined}
      className={cx("loki-row", dense && "loki-row--dense", touch && "loki-row--touch", flush && "loki-row--flush", className)}
      {...rest}
    />
  );
});

/** The props of `Sheet`, loki's one dialog: its name, how it closes, its size and where it sits. */
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
  /** Nothing dims behind it: a floating panel (the model switcher) that a click outside still closes. */
  clear?: boolean;
  className?: string;
  style?: CSSProperties;
  cardProps?: HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, unknown>;
  children: ReactNode;
}

/**
 * loki's one dialog. On the desktop it is shadcn's Dialog on Base UI (plan 2026-11-15-1900, KTD1): modal, focus held
 * inside and put on the first control (or the one marked `autofocus`), returned to the opener on close, Esc and a
 * click outside closing it as `onClose` and `escape` allow, the rest of the window hidden from a screen reader. A bottom
 * sheet (the phone's) keeps its own markup (KTD3): it is drawn at the phone shell's root, above the screen it covers so
 * that screen can recede under it, and moves as an iOS sheet does (sheet-motion.ts).
 */
export function Sheet(props: SheetProps) {
  return props.placement === "bottom" ? <BottomSheet {...props} /> : <DialogSheet {...props} />;
}

/**
 * Whether a dismissal Base UI reports closes a desktop sheet (plan 2026-11-15-1900, KTD2): Esc only when the sheet lets
 * it (a sheet that reads its own keys, Change Folder, says not), a click outside or anything else whenever it can close.
 */
export function sheetCloses(reason: string, { canClose, escape }: { canClose: boolean; escape: boolean }): boolean {
  if (!canClose) return false;
  return reason !== "escape-key" || escape;
}

/**
 * A desktop sheet: shadcn's Dialog parts with loki's veil and card (KTD1). The caller mounts it to open it and unmounts
 * it to close it, so the Dialog is always open; a dismissal Base UI reports goes to `onClose` by its reason (KTD2).
 */
function DialogSheet({
  label,
  onClose,
  width = 560,
  height,
  top,
  scroll,
  zIndex = LAYER.modal,
  escape = !!onClose,
  clear = false,
  className,
  style,
  cardProps,
  children,
}: SheetProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  // Opened by a click it fades and rises; opened by a key (search, the keys sheet) it is simply there.
  const [grows] = useState(() => lastInput() === "pointer");
  const viewportStyle = { zIndex, ...(top ? ({ "--sheet-top": top } as CSSProperties) : null) };
  return (
    <Dialog
      open
      disablePointerDismissal={!onClose}
      onOpenChange={(open, details) => {
        if (!open && onClose && sheetCloses(details.reason, { canClose: true, escape })) onClose();
      }}
    >
      <DialogPortal>
        <DialogOverlay className={cx("loki-sheet-veil", clear && "loki-sheet-veil--clear")} data-grow={grows || undefined} style={{ zIndex }} />
        <DialogViewport className={cx("loki-sheet-viewport", scroll && "loki-sheet-viewport--scroll")} style={viewportStyle}>
          <DialogPopup
            ref={cardRef}
            // Base UI makes the rest of the window inert; aria-modal says so to a screen reader that reads it.
            aria-modal="true"
            aria-label={label}
            initialFocus={() => (cardRef.current && firstControl(cardRef.current)) ?? true}
            data-grow={grows || undefined}
            className={cx("loki-sheet", "loki-sheet-card", className)}
            style={{ width, ...(height !== undefined ? { height, maxHeight: "none" } : null), ...style }}
            {...cardProps}
          >
            {children}
          </DialogPopup>
        </DialogViewport>
      </DialogPortal>
    </Dialog>
  );
}

/** The props of `Popover`: a div's, with its control, whether it is open, the edge and side it hangs from and its width. */
export interface PopoverProps extends Omit<HTMLAttributes<HTMLDivElement>, "role"> {
  /** The control it hangs from, a button that passes on the props and ref it is given; it opens and closes the popover. */
  trigger: ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>;
  open: boolean;
  /** Asked to open or close: a press on the control, Esc, or a press outside. */
  onOpenChange: (open: boolean) => void;
  /** A dialog that holds fields, or a menu of rows. */
  role: "dialog" | "menu";
  "aria-label": string;
  /** Which edge of the control it lines up with. */
  anchor?: "left" | "right";
  /** Below the control (the default) or above it, for a control along a panel's foot. */
  side?: "below" | "above";
  width?: number;
  /** What takes the focus when it opens; omitted, the panel itself. */
  initialFocus?: () => HTMLElement | null | undefined;
  /** The phone's markup, wherever it is drawn. */
  touch?: boolean;
  ref?: Ref<HTMLDivElement>;
}

/**
 * A small panel hung from the control that opens it: a list of links, a folder field, a menu. On the desktop it is
 * shadcn's Popover on Base UI (plan 2026-11-15-2130): drawn over the window beside its control, on the side with room,
 * and closed by Esc, a press outside or the control again, with focus going back to the control. Opened by a click it
 * grows out of the corner it hangs from; opened by a key it is simply there. The phone draws its own panel beside the
 * control (KTD2).
 */
export function Popover({
  trigger,
  open,
  onOpenChange,
  anchor = "left",
  side = "below",
  width = 320,
  initialFocus,
  touch,
  ref,
  className,
  style,
  ...rest
}: PopoverProps) {
  const grows = open && lastInput() === "pointer";
  if (inLan || touch)
    return (
      <PhonePopover
        trigger={trigger}
        open={open}
        onOpenChange={onOpenChange}
        anchor={anchor}
        side={side}
        width={width}
        initialFocus={initialFocus}
        ref={ref}
        className={className}
        style={style}
        grows={grows}
        {...rest}
      />
    );
  return (
    <UiPopover open={open} onOpenChange={(next) => onOpenChange(next)}>
      <PopoverTrigger render={trigger} aria-haspopup={rest.role} />
      <PopoverContent
        ref={ref}
        side={side === "above" ? "top" : "bottom"}
        align={anchor === "right" ? "end" : "start"}
        sideOffset={6}
        initialFocus={initialFocus ? () => initialFocus() ?? true : true}
        className={cx("loki-popover loki-popover--anchored gap-0 p-0", !grows && "data-open:animate-none", className)}
        style={{ width, ...style }}
        {...rest}
      />
    </UiPopover>
  );
}

/** A shortcut hint: mono (keys are data), muted, hairlined. */
export function Kbd({ children, className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span aria-hidden className={cx("loki-kbd", className)} {...rest}>
      {children}
    </span>
  );
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
export function Dot({
  size = 6,
  color,
  ring,
  pulse,
  halo,
  className,
  style,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & {
  size?: number;
  color: string;
  ring?: boolean;
  pulse?: boolean;
  /** A panel-coloured ring, to sit on an icon. */ halo?: boolean;
}) {
  return (
    <span
      className={cx("loki-dot", pulse && "loki-pulse", halo && "loki-dot--halo", className)}
      style={{ width: size, height: size, background: ring ? "transparent" : color, border: `1px solid ${color}`, ...style }}
      {...rest}
    />
  );
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

/** On the phone a banner slides back up where it came from as it goes (it slides down as it comes, phone.css); the desktop's just goes. */
const bannerLeave = (el: HTMLElement) =>
  el.closest(".loki-phone")
    ? [
        { opacity: 1, transform: "none" },
        { opacity: 0, transform: "translateY(-100%)" },
      ]
    : null;

/** A line across the top of a surface: the Mac is unreachable, an update is ready. Tone is a dot, not a stripe. */
export function Banner({ tone = "var(--loki-negative)", children, className, ...rest }: HTMLAttributes<HTMLDivElement> & { tone?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLeave(ref, bannerLeave, 220);
  return (
    <div ref={ref} role="status" className={cx("loki-banner", className)} {...rest}>
      <Dot color={tone} />
      <span className="min-w-0">{children}</span>
    </div>
  );
}

/**
 * The window's notices (Sonner): one stack at the top right, under the window's top bar, in loki's colours
 * (components.css .loki-notices),
 * over everything but a sheet. Mounted once, by the shell; `notify` shows one from anywhere: a line that goes after
 * four seconds, or one that stays with its buttons (`duration: Infinity`, `action`, `cancel`).
 */
export function Notices() {
  return (
    <Toaster
      className="loki-notices"
      position="top-right"
      offset={{ top: 56, right: 16 }}
      visibleToasts={3}
      duration={4000}
      style={{ zIndex: LAYER.toast }}
      toastOptions={{ className: "loki-notice", classNames: { actionButton: "loki-notice-action", cancelButton: "loki-notice-cancel" } }}
    />
  );
}

/** Show a notice (Sonner's `toast`): see `Notices`. */
export const notify = toast;

/**
 * An on/off switch with its label: Preferences › Phone (the listener), Preferences › Keyboard shortcuts (⌥Space). `hideLabel` keeps the
 * label for a screen reader only, where the setting's name already stands beside it.
 */
export function Switch({
  on,
  onToggle,
  label,
  small = false,
  hideLabel = false,
}: {
  on: boolean;
  onToggle: () => void;
  label: string;
  small?: boolean;
  hideLabel?: boolean;
}) {
  if (!inLan)
    return (
      <label className={cx("inline-flex cursor-pointer items-center gap-2", small ? "text-xs" : "text-sm", on ? "text-foreground" : "text-muted-foreground")}>
        <UiSwitch checked={on} onCheckedChange={() => onToggle()} aria-label={hideLabel ? label : undefined} size={small ? "sm" : "default"} />
        {!hideLabel && label}
      </label>
    );
  return <PhoneSwitch on={on} onToggle={onToggle} label={label} small={small} hideLabel={hideLabel} />;
}

// ---- Slack building blocks (plan 013) ---------------------------------------------------------------

/** "99+" past two digits, as the rail's and the phone's badges do. */
export const countText = (n: number): string => (n > 99 ? "99+" : String(n));

/**
 * A row's state in words, for the screen reader and for anyone who cannot tell the red badge or the bold
 * title apart: "unread, 3 waiting, working". A `note` says more than "unread" and takes its place ("viewed, not done").
 * Empty when there is nothing to say.
 */
export function rowStatus({
  unread,
  badge,
  badgeNoun = "waiting",
  live,
  note,
}: {
  unread?: boolean;
  badge?: number | null;
  badgeNoun?: string;
  live?: boolean;
  note?: string;
}): string {
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

/**
 * The props of `ListRow`, the one row the sidebars and list-and-detail lists draw: its lead, title and preview, the
 * badge and status marks, and its open, menu and row actions.
 */
export interface ListRowProps {
  /** The start: an agent's face (AgentFace at 20) or a ListIcon. */
  lead?: ReactNode;
  title: ReactNode;
  /** One muted line under the title. Sidebar rows leave it out; list-and-detail lists (agents, learn) use it. */
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
  /**
   * The working dot sits on the right, in the badge's place (a badge outranks it), rather than on the lead: rows whose
   * marks line up in one column (the Chats sidebar).
   */
  liveAtEnd?: boolean;
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
  /** `data-row`: the item's id, so a list with a roving tab stop can find the row to focus (shell/content-list.tsx). */
  rowId?: string;
  /** The row button's tab stop: -1 on every row of a roving list but the one Tab lands on. */
  tabIndex?: number;
  /** Keys on the row button itself, for a list that takes its own arrows (shell/content-list.tsx). */
  onKeyDown?: (e: KeyboardEvent<HTMLButtonElement>) => void;
}

/**
 * One row of a desktop list, Slack's anatomy: the lead, the title (bold when unread) over an optional
 * preview, and on the right the time (on the title's line) or the red badge. The whole row is one button;
 * `actions` sit beside it, not inside, so they are their own tab stops. Goes inside a ListSection or a
 * `<ul className="loki-list">`.
 */
export function ListRow({
  lead,
  title,
  preview,
  time,
  badge,
  badgeNoun,
  unread = false,
  note,
  live = false,
  liveAtEnd = false,
  current = false,
  dim = false,
  flags,
  label,
  onOpen,
  onMenu,
  actions,
  launch,
  rowId,
  tabIndex,
  onKeyDown,
}: ListRowProps) {
  const count = badge != null && badge > 0 ? badge : null;
  const status = rowStatus({ unread, badge: count, badgeNoun, live, note });
  // The badge springs in when something new needs you (its count goes up), not when the list first draws.
  const [shown, setShown] = useState(count);
  const [pops, setPops] = useState(0);
  if (shown !== count) {
    setShown(count);
    if (count !== null && (shown === null || count > shown)) setPops((n) => n + 1);
  }
  const liveDot = live && !liveAtEnd ? <span aria-hidden className="loki-list-row-live" /> : null;
  // The time sits on the name line, so a row with a preview shows it at the top as Mail does; a badge or the live
  // mark at the end takes its place at the row's right edge instead.
  const showTime = count === null && !(live && liveAtEnd) && !!time;
  return (
    <li className="loki-list-item" data-dim={dim || undefined} data-current={current || undefined}>
      <button
        type="button"
        className={cx("loki-list-row", unread && "loki-list-row--unread")}
        aria-current={current ? "page" : undefined}
        aria-label={label}
        tabIndex={tabIndex}
        data-launch={launch}
        data-row={rowId}
        onClick={onOpen}
        onKeyDown={onKeyDown}
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
            {showTime && <span className="loki-list-row-time">{time}</span>}
          </span>
          {preview && <span className="loki-list-row-preview">{preview}</span>}
        </span>
        {status && <span className="sr-only">{status}</span>}
        {count !== null ? (
          <span key={pops} className="loki-list-badge" data-pop={pops > 0 || undefined} aria-hidden title={`${countText(count)} ${badgeNoun ?? "waiting"}`}>
            {countText(count)}
          </span>
        ) : live && liveAtEnd ? (
          <span aria-hidden className="loki-list-row-live loki-list-row-live--end" title="Working" />
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
export function ListSection({
  title,
  icon,
  face,
  count,
  aside,
  open = true,
  onToggle,
  actions,
  children,
}: {
  title: string;
  icon?: IconName;
  /** A face before the title in place of an icon (an agent's, on its section). */
  face?: ReactNode;
  count?: number | null;
  /** Quiet words at the head's right, before the actions (the Mac an agent lives on). */
  aside?: ReactNode;
  open?: boolean;
  onToggle?: () => void;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const inner = (
    <>
      {onToggle && <Icon name="chevron-down" size={12} className={cx("loki-list-section-chev", !open && "loki-list-section-chev--folded")} />}
      {face ?? (icon && <Icon name={icon} size={14} />)}
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
        {aside && <span className="loki-list-section-aside">{aside}</span>}
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
 * The tab views under a pane's title, a segmented capsule as a Mac toolbar's: shadcn's Tabs on Base UI (plan
 * 2026-11-15-2130, KTD3). A tablist with a roving tab stop: Tab lands on the chosen tab, and the arrow keys, Home and End
 * move and choose. `panelId` names the panel each tab controls, which the host draws outside the row.
 */
export function TabRow<T extends string>({
  label,
  tabs,
  current,
  onChange,
  panelId,
}: {
  label: string;
  tabs: ReadonlyArray<Tab<T>>;
  current: T;
  onChange: (id: T) => void;
  panelId?: (id: T) => string;
}) {
  return (
    <Tabs
      value={current}
      onValueChange={(value: unknown) => {
        const next = tabs.find((t) => t.id === value);
        if (next) onChange(next.id);
      }}
      className="contents"
    >
      <TabsList aria-label={label} activateOnFocus className="loki-tabs h-auto gap-0.5 rounded-full p-0.5">
        {tabs.map((t) => (
          <TabsTrigger
            key={t.id}
            value={t.id}
            aria-controls={panelId?.(t.id)}
            className="loki-tab flex-none gap-2 rounded-full px-3 dark:data-active:border-transparent"
          >
            {t.icon && <Icon name={t.icon} size={14} />}
            {t.label}
            {t.count != null && t.count > 0 && <span className="loki-tab-count">{countText(t.count)}</span>}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

/** The props of `PaneHeader`: the title line's parts, optional tab views and the trailing symbols. */
export interface PaneHeaderProps<T extends string = string> {
  title: ReactNode;
  /** Before the title: a # icon or the agent's face. */
  lead?: ReactNode;
  /** A quiet line beside the title: the agent and its live state. */
  aside?: ReactNode;
  /** A quiet line under the title, such as the chat's purpose; omitted, there is none. */
  subtitle?: ReactNode;
  /** On the right: the pane's actions (IconButtons, a menu). */
  actions?: ReactNode;
  /**
   * The tab views, centred in the toolbar between the title and the trailing symbols (plan 2026-11-14-1330, KTD11);
   * omitted, the title has the line to itself.
   */
  tabs?: ReadonlyArray<Tab<T>>;
  tab?: T;
  onTab?: (id: T) => void;
  /** The tablist's name, e.g. "Desk views". */
  tabsLabel?: string;
  panelId?: (id: T) => string;
  /** The title's id, so the pane can be labelled by it. */
  titleId?: string;
  /** A whole line drawn in place of the lead, title, aside and actions: the chat pane's item header (plan 097). */
  line?: ReactNode;
  /** At the trailing edge, after the tabs: Liquid Glass's toolbar items (plan 2026-11-12-1505, U13). */
  trailing?: ReactNode;
}

/**
 * The detail's toolbar, one band as Mail's: the name over its grey line, the tab views centred, the symbols at the
 * trailing edge. The trailing side is always there, even empty, so it can leave room for the Update button the shell
 * lays over the detail's top right (plan 2026-11-14-1330, U4).
 */
export function PaneHeader<T extends string>({
  title,
  lead,
  aside,
  subtitle,
  actions,
  tabs,
  tab,
  onTab,
  tabsLabel = "Views",
  panelId,
  titleId,
  line,
  trailing,
}: PaneHeaderProps<T>) {
  return (
    <header className="loki-pane-header">
      {/* The name line drags the window in the app (the native title bar is hidden); its buttons still click. */}
      <div className="loki-pane-header-line" data-tauri-drag-region="deep">
        {line ?? (
          <>
            {lead && <span className="loki-pane-header-lead">{lead}</span>}
            <h1 id={titleId} className="loki-pane-title">
              {title}
            </h1>
            {aside && <span className="loki-meta loki-pane-header-aside">{aside}</span>}
            {actions && <span className="loki-pane-header-actions">{actions}</span>}
          </>
        )}
      </div>
      {subtitle && <div className="loki-pane-header-subtitle">{subtitle}</div>}
      {tabs && tab !== undefined && onTab && <TabRow label={tabsLabel} tabs={tabs} current={tab} onChange={onTab} panelId={panelId} />}
      <div className="loki-pane-header-trailing">{trailing}</div>
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
