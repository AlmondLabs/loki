import type { SVGProps } from "react";
import {
  ArchiveIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  CopyIcon,
  EllipsisIcon,
  FileTextIcon,
  FolderIcon,
  HashIcon,
  HistoryIcon,
  HouseIcon,
  InboxIcon,
  InfoIcon,
  LaptopIcon,
  LayoutGridIcon,
  LightbulbIcon,
  LinkIcon,
  ListFilterIcon,
  MailIcon,
  MenuIcon,
  MessageSquareIcon,
  MicIcon,
  MoonIcon,
  PencilIcon,
  PinIcon,
  PlusIcon,
  RefreshCwIcon,
  ScanTextIcon,
  SearchIcon,
  SendIcon,
  SlidersHorizontalIcon,
  SparkleIcon,
  SparklesIcon,
  SquareIcon,
  SquarePenIcon,
  SquareTerminalIcon,
  SunIcon,
  TicketIcon,
  UnlinkIcon,
  UserIcon,
  UsersIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
/**
 * loki's one icon set, Lucide's (plan 2026-11-12-1505, R8; the person's choice, 2026-11-13), the one its toolbars,
 * composer and menus use: outlined at a 1.75 stroke in currentColor, so a control's text colour is its icon colour.
 * Controls use these, never text glyphs or emoji. Each name maps to Lucide's drawing of the idea; a chat is a speech
 * bubble. One class (.loki-icon, components.css); the phone adds its own (phone/icons.tsx).
 */
const ICONS = {
  home: HouseIcon,
  inbox: InboxIcon,
  agents: UsersIcon,
  person: UserIcon,
  more: EllipsisIcon,
  search: SearchIcon,
  back: ChevronLeftIcon,
  "chevron-right": ChevronRightIcon,
  "chevron-down": ChevronDownIcon,
  close: XIcon,
  plus: PlusIcon,
  send: SendIcon,
  clock: ClockIcon,
  check: CheckIcon,
  archive: ArchiveIcon,
  learn: LightbulbIcon,
  settings: SlidersHorizontalIcon,
  link: LinkIcon,
  info: InfoIcon,
  pin: PinIcon,
  widget: LayoutGridIcon,
  filter: ListFilterIcon,
  menu: MenuIcon,
  refresh: RefreshCwIcon,
  mic: MicIcon,
  compose: SquarePenIcon,
  desk: MessageSquareIcon,
  laptop: LaptopIcon,
  sun: SunIcon,
  moon: MoonIcon,
  terminal: SquareTerminalIcon,
  stop: SquareIcon,
  copy: CopyIcon,
  select: ScanTextIcon,
  suggest: SparklesIcon,
  pencil: PencilIcon,
  file: FileTextIcon,
  folder: FolderIcon,
  skill: SparkleIcon,
  history: HistoryIcon,
  unlink: UnlinkIcon,
  mail: MailIcon,
  hash: HashIcon,
  ticket: TicketIcon,
} satisfies Record<string, LucideIcon>;

/** The name of one of loki's icons. */
export type IconName = keyof typeof ICONS;

/** The icons drawn filled, so a small mark reads as solid. */
const FILLED: ReadonlySet<IconName> = new Set(["stop"]);

/**
 * A Lucide icon given directly rather than by name, at loki's stroke (plan 2026-11-12-1505, R8); `inline` sits it in a
 * line of text rather than alone in a control.
 */
export function Glyph({ icon: Drawn, size = 14, inline = false }: { icon: LucideIcon; size?: number; inline?: boolean }) {
  return <Drawn aria-hidden size={size} strokeWidth={1.75} className={inline ? "loki-icon loki-icon--inline" : "loki-icon"} />;
}

/** The props of `Icon`: an SVG's, with the icon's name, its size and an optional accessible name. */
export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name" | "children"> {
  name: IconName;
  /** Rendered square side in px; the drawing stays on its 24-unit box. */
  size?: number;
  /** Given, the icon is announced as an image with this name; otherwise it is decoration for a labelled control. */
  title?: string;
}

/** One icon from the registry. The control around it owns the 44px target and the accessible name. */
export function Icon({ name, size = 24, title, className, ...rest }: IconProps) {
  const Drawn = ICONS[name];
  return (
    <Drawn
      size={size}
      strokeWidth={1.75}
      className={className ? `loki-icon ${className}` : "loki-icon"}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
      {...(FILLED.has(name) ? { fill: "currentColor" } : {})}
      {...rest}
    >
      {title && <title>{title}</title>}
    </Drawn>
  );
}
