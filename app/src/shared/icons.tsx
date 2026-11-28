import type { SVGProps } from "react";
import {
  ArchiveIcon,
  BotIcon,
  BrainIcon,
  CodeIcon,
  GlobeIcon,
  ListChecksIcon,
  MessageCircleQuestionMarkIcon,
  WrenchIcon,
  ChartColumnIcon,
  CpuIcon,
  KeyboardIcon,
  PaletteIcon,
  PlugIcon,
  SmartphoneIcon,
  TagIcon,
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
  TargetIcon,
  TicketIcon,
  Trash2Icon,
  UnlinkIcon,
  UserIcon,
  UsersIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
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
  palette: PaletteIcon,
  keyboard: KeyboardIcon,
  cpu: CpuIcon,
  plug: PlugIcon,
  phone: SmartphoneIcon,
  tag: TagIcon,
  chart: ChartColumnIcon,
  trash: Trash2Icon,
  globe: GlobeIcon,
  bot: BotIcon,
  code: CodeIcon,
  wrench: WrenchIcon,
  question: MessageCircleQuestionMarkIcon,
  brain: BrainIcon,
  checklist: ListChecksIcon,
  target: TargetIcon,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export const glyphOf = (name: IconName): LucideIcon => ICONS[name];

const FILLED: ReadonlySet<IconName> = new Set(["stop"]);

export function Glyph({ icon: Drawn, size = 14, inline = false }: { icon: LucideIcon; size?: number; inline?: boolean }) {
  return <Drawn aria-hidden size={size} strokeWidth={1.75} className={inline ? "loki-icon loki-icon--inline" : "loki-icon"} />;
}

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name" | "children"> {
  name: IconName;
  size?: number;
  title?: string;
}

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
