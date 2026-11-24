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
import { forwardRef, useId, useRef, useState } from "react";
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

export type Tone = "quiet" | "paper" | "brass" | "positive" | "negative";
export type Size = "sm" | "md" | "touch";

export const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: Tone;
  size?: Size;
  bare?: boolean;
  block?: boolean;
  kbd?: ReactNode;
}

const phoneMarkup = (size?: Size) => inLan || size === "touch";

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

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  label: string;
  size?: 24 | 28 | 36 | 40;
  tone?: Tone;
  hairline?: boolean;
  danger?: boolean;
  children: ReactNode;
}

const ICON_SIZE = { 24: "icon-xs", 28: "icon-sm", 36: "icon", 40: "icon-lg" } as const;

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

export function NavButton({ current, className, type = "button", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { current: boolean }) {
  return <button type={type} aria-current={current ? "page" : undefined} className={cx("loki-nav", className)} {...rest} />;
}

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  ref?: Ref<HTMLButtonElement>;
  active?: boolean;
  brass?: boolean;
  attention?: boolean;
  tone?: string;
  static?: boolean;
  touch?: boolean;
  label?: boolean;
  float?: boolean;
  tag?: boolean;
}

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
  size?: Size;
  mono?: boolean;
  bare?: boolean;
  inline?: boolean;
}
const FIELD_SIZE: Record<Size, string | null> = { sm: "loki-field--sm", md: null, touch: "loki-field--touch" };
const fieldClass = ({ size = "md", mono, bare, inline }: FieldMods, className?: string) =>
  cx("loki-field", FIELD_SIZE[size], mono && "loki-field--mono", bare && "loki-field--bare", inline && "loki-field--inline", className);

export type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & FieldMods;
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

export type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & FieldMods;
export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea({ size, mono, bare, inline, className, ...rest }, ref) {
  return <textarea ref={ref} className={fieldClass({ size, mono, bare, inline }, className)} {...rest} />;
});

export interface RowProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  selected?: boolean;
  dense?: boolean;
  touch?: boolean;
  flush?: boolean;
}

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

export interface SheetProps {
  label: string;
  onClose?: () => void;
  width?: number | string;
  height?: number | string;
  top?: string;
  placement?: "top" | "bottom";
  scroll?: boolean;
  zIndex?: number;
  escape?: boolean;
  clear?: boolean;
  className?: string;
  style?: CSSProperties;
  cardProps?: HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, unknown>;
  children: ReactNode;
}

export function Sheet(props: SheetProps) {
  return props.placement === "bottom" ? <BottomSheet {...props} /> : <DialogSheet {...props} />;
}

export function sheetCloses(reason: string, { canClose, escape }: { canClose: boolean; escape: boolean }): boolean {
  if (!canClose) return false;
  return reason !== "escape-key" || escape;
}

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

export interface PopoverProps extends Omit<HTMLAttributes<HTMLDivElement>, "role"> {
  trigger: ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  role: "dialog" | "menu";
  "aria-label": string;
  anchor?: "left" | "right";
  side?: "below" | "above";
  width?: number;
  initialFocus?: () => HTMLElement | null | undefined;
  touch?: boolean;
  ref?: Ref<HTMLDivElement>;
}

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

export function Kbd({ children, className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span aria-hidden className={cx("loki-kbd", className)} {...rest}>
      {children}
    </span>
  );
}

export function Meta({ brass, negative, wrap, className, ...rest }: HTMLAttributes<HTMLSpanElement> & { brass?: boolean; negative?: boolean; wrap?: boolean }) {
  return <span className={cx("loki-meta", brass && "loki-meta--brass", negative && "loki-meta--negative", wrap && "loki-meta--wrap", className)} {...rest} />;
}

export function Title({ page, className, ...rest }: HTMLAttributes<HTMLDivElement> & { page?: boolean }) {
  return <div className={cx("loki-title", page && "loki-title--page", className)} {...rest} />;
}

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
  halo?: boolean;
}) {
  return (
    <span
      className={cx("loki-dot", pulse && "loki-pulse", halo && "loki-dot--halo", className)}
      style={{ width: size, height: size, background: ring ? "transparent" : color, border: `1px solid ${color}`, ...style }}
      {...rest}
    />
  );
}

export function Empty({ title, children, card, className, ...rest }: HTMLAttributes<HTMLDivElement> & { title: ReactNode; card?: boolean }) {
  return (
    <div className={cx("loki-empty", card && "loki-empty--card", className)} {...rest}>
      <Title>{title}</Title>
      {children}
    </div>
  );
}

const bannerLeave = (el: HTMLElement) =>
  el.closest(".loki-phone")
    ? [
        { opacity: 1, transform: "none" },
        { opacity: 0, transform: "translateY(-100%)" },
      ]
    : null;

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

export const notify = toast;

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

export const countText = (n: number): string => (n > 99 ? "99+" : String(n));

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

export function ListIcon({ name }: { name: IconName }) {
  return (
    <span aria-hidden className="loki-list-icon">
      <Icon name={name} size={16} />
    </span>
  );
}

export interface ListRowProps {
  lead?: ReactNode;
  title: ReactNode;
  preview?: ReactNode;
  time?: string | null;
  badge?: number | null;
  badgeNoun?: string;
  unread?: boolean;
  note?: string;
  live?: boolean;
  liveAtEnd?: boolean;
  current?: boolean;
  dim?: boolean;
  flags?: ReactNode;
  label?: string;
  onOpen: () => void;
  onMenu?: (e: MouseEvent<HTMLButtonElement>) => void;
  actions?: ReactNode;
  launch?: string;
  rowId?: string;
  tabIndex?: number;
  onKeyDown?: (e: KeyboardEvent<HTMLButtonElement>) => void;
}

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
  const [shown, setShown] = useState(count);
  const [pops, setPops] = useState(0);
  if (shown !== count) {
    setShown(count);
    if (count !== null && (shown === null || count > shown)) setPops((n) => n + 1);
  }
  const liveDot = live && !liveAtEnd ? <span aria-hidden className="loki-list-row-live" /> : null;
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
  face?: ReactNode;
  count?: number | null;
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

export interface TabStatus {
  glyph: ReactNode;
  words: string;
}

export interface Tab<T extends string = string> {
  id: T;
  label: string;
  icon?: IconName;
  count?: number | null;
  status?: TabStatus | null;
}

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
  const described = useId();
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
            title={t.status?.words}
            aria-describedby={t.status ? `${described}-${t.id}` : undefined}
            className="loki-tab flex-none gap-2 rounded-full px-3 dark:data-active:border-transparent"
          >
            {t.icon && <Icon name={t.icon} size={14} />}
            {t.label}
            {t.status?.glyph}
            {t.count != null && t.count > 0 && <span className="loki-tab-count">{countText(t.count)}</span>}
            {t.status && (
              <span id={`${described}-${t.id}`} hidden>
                {t.status.words}
              </span>
            )}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

export interface PaneHeaderProps<T extends string = string> {
  title: ReactNode;
  lead?: ReactNode;
  aside?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  tabs?: ReadonlyArray<Tab<T>>;
  tab?: T;
  onTab?: (id: T) => void;
  tabsLabel?: string;
  panelId?: (id: T) => string;
  titleId?: string;
  line?: ReactNode;
  trailing?: ReactNode;
}

export function LeadRoom() {
  return <span aria-hidden className="loki-lead-room" />;
}

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
      <div className="loki-pane-header-line" data-tauri-drag-region="deep">
        <LeadRoom />
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
