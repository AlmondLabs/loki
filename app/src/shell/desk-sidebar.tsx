import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  FolderIcon,
  MailDotIcon,
  MailOpenIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  TagIcon,
  ArrowUpIcon,
  ArrowDownIcon,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type Ref } from "react";
import { IconButton, ListIcon } from "../components";
import { ago } from "../shared/ago";
import { Icon, Glyph } from "../shared/icons";
import type { AttentionItem } from "../../../core/attention/model.ts";

import { ContentList, type ContentListHandle, type ContentRow } from "./content-list";
import { keyFor } from "./keymap";
import {
  ALL_CHATS,
  ARCHIVED_CHATS,
  CHAT_STATES,
  PINNED_CHATS,
  canArchive,
  canMove,
  canLabel,
  canPin,
  canRename,
  doneAction,
  moveTargets,
  offscreenWaits,
  type ChatSource,
  type ChatState,
  type MoveTarget,
  type SourceRow,
} from "./sidebar-model";
import type { CatchUp, Desk } from "./types";
import { NO_RENAME_REASON, RenameDesk, renameDesk, savePurpose } from "../desk/rename-desk";
import { ChangeFolder, type FolderApi } from "../desk/new-desk";
import { conversationDirName } from "../../../core/desk-core.ts";
import { HomeMark } from "./home-mark";
import { prefersReducedMotion } from "../kit/motion";
import "./desk-sidebar.css";
import { popUpMenu, NATIVE_MENUS, type MenuEntry } from "./native-menu";
import { FilterPills, type FilterPill } from "./filter-pills";
import { ActivityIcon, BellIcon, CircleDotIcon, MessagesSquareIcon, type LucideIcon } from "lucide-react";
import { DrawnMenu } from "./menu-items";
import type { DeskSummary } from "../../../core/frame-types.ts";
import type { Pushes } from "../../../core/frames.ts";
import type { LabelView } from "../../../core/labels.ts";
import { LabelsDialog } from "../chat/labels";

const launchOf = (scope: string) => `desk:${scope}`;
const NEW_ROW = ":new";

const NO_ARCHIVE_REASON = "Archiving needs loki's daemon, which is not connected";
const NO_MOVE_REASON = "Changing folder needs loki's daemon, which is not connected";
const NO_LABEL_REASON = "Labels need loki's daemon, which is not connected";

function emptyFor(source: Pick<ChatSource, "id" | "title">): string {
  if (source.id === ALL_CHATS) return "No chats yet.";
  if (source.id === PINNED_CHATS) return "No pinned chats.";
  if (source.id === ARCHIVED_CHATS) return "No archived chats.";
  return `No chats with ${source.title} yet.`;
}

export interface ChatListProps {
  rows: SourceRow[];
  stateFilter?: { state: ChatState; onState: (state: ChatState) => void };
  source: Pick<ChatSource, "id" | "title" | "agentId">;
  selected: string | null;
  shown: boolean;
  desks: DeskSummary[];
  items: AttentionItem[];
  connected: boolean;
  onSelect: (scope: string) => void;
  onEnter: (scope: string | null) => void;
  onNew?: (agentId: string | null) => void;
  drafting?: boolean;
  onPin: (desk: DeskSummary, pinned: boolean) => void;
  onArchive: (desk: DeskSummary, archived: boolean) => void;
  onRename: (desk: DeskSummary, name: string) => Promise<string | null>;
  onPurpose?: (desk: DeskSummary, purpose: string) => Promise<string | null>;
  onMove?: (desk: DeskSummary, folder: string) => Promise<string | null>;
  folders?: FolderApi;
  onDone?: (item: AttentionItem, done: boolean) => void;
  query: string;
  onQuery: (query: string) => void;
  labels?: { list: LabelView[] | null; set: (desk: DeskSummary, labels: string[]) => Promise<string | null> };
  homes?: { here: string; of: (agentId: string) => { mac: string; name: string } | null };
  macs?: { view: Pushes["peers"] | null; move: (desk: DeskSummary, to: MoveTarget) => void };
  ref?: Ref<ContentListHandle>;
}

export function ChatList({
  rows,
  stateFilter,
  source,
  selected,
  shown,
  desks,
  items,
  connected,
  onSelect,
  onEnter,
  onNew,
  drafting = false,
  onPin,
  onArchive,
  onRename,
  onPurpose,
  onMove,
  folders,
  onDone,
  query,
  onQuery,
  labels,
  macs,
  homes,
  ref,
}: ChatListProps) {
  const [menu, setMenu] = useState<{ desk: DeskSummary; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<DeskSummary | null>(null);
  const [moving, setMoving] = useState<DeskSummary | null>(null);
  const [labeling, setLabeling] = useState<DeskSummary | null>(null);
  const [pills, setPills] = useState<{ up: string | null; down: string | null; top: number }>({ up: null, down: null, top: 0 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const rowEl = (scope: string) => wrapRef.current?.querySelector<HTMLElement>(`[data-launch="${CSS.escape(launchOf(scope))}"]`) ?? null;

  const waiting = useMemo(() => rows.filter((r) => r.kind === "waits").map((r) => r.desk.scope), [rows]);
  const measure = useCallback(() => {
    const el = wrapRef.current?.querySelector<HTMLElement>(".loki-content-list-rows");
    if (!el) return;
    const box = el.getBoundingClientRect();
    const at = waiting.flatMap((scope) => {
      const r = wrapRef.current?.querySelector(`[data-launch="${CSS.escape(launchOf(scope))}"]`)?.getBoundingClientRect();
      return r ? [{ id: scope, top: r.top - box.top + el.scrollTop, bottom: r.bottom - box.top + el.scrollTop }] : [];
    });
    const next = { ...offscreenWaits(at, { top: el.scrollTop, bottom: el.scrollTop + el.clientHeight }), top: el.offsetTop };
    setPills((p) => (p.up === next.up && p.down === next.down && p.top === next.top ? p : next));
  }, [waiting]);
  useLayoutEffect(measure, [measure, rows]);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  useEffect(() => {
    const list = wrapRef.current?.querySelector<HTMLElement>(".loki-content-list-rows");
    const row = selected === null ? null : wrapRef.current?.querySelector<HTMLElement>(`[data-launch="${CSS.escape(launchOf(selected))}"]`);
    if (!list || !row) return;
    const box = list.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    if (r.top < box.top) list.scrollTop -= box.top - r.top;
    else if (r.bottom > box.bottom) list.scrollTop += r.bottom - box.bottom;
  }, [selected, source.id]);

  const reveal = (scope: string | null) => {
    if (!scope) return;
    const row = rowEl(scope);
    row?.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    row?.focus({ preventScroll: true });
  };

  const itemOf = (d: DeskSummary) => items.find((i) => i.agent_id === d.agent_id && i.id === d.conversation_id) ?? null;
  const deskOf = (scope: string) => desks.find((d) => d.scope === scope);
  const menuEntries = (d: DeskSummary) =>
    rowMenuEntries({
      desk: d,
      item: itemOf(d),
      connected,
      onOpen: onEnter,
      onPin,
      onArchive,
      onRename: setRenaming,
      onMove: onMove && folders ? setMoving : undefined,
      onLabels: labels ? setLabeling : undefined,
      onDone,
      targets: macs ? moveTargets(d, macs.view) : [],
      onMoveTo: macs?.move,
    });
  const openMenu = (scope: string, e: MouseEvent<HTMLButtonElement>) => {
    const d = deskOf(scope);
    if (!d) return;
    const box = e.currentTarget.getBoundingClientRect();
    // Outside (HTML): the context-menu key gives a pointer at 0,0, so the menu then hangs from the row.
    const x = e.clientX || box.left + 24;
    const y = e.clientY || box.bottom;
    if (NATIVE_MENUS) void popUpMenu(menuEntries(d), { x, y }).catch((err: unknown) => console.warn("loki: row menu", err));
    else setMenu({ desk: d, x, y });
  };

  const chatRow = (r: SourceRow): ContentRow => {
    const d = r.desk;
    const pinnable = canPin(d);
    const archivable = canArchive(d);
    return {
      id: d.scope,
      section: r.section,
      title: d.title ?? (r.main ? "Main chat" : d.status === "live" ? "New chat" : d.scope),
      time: ago(d.last_active),
      badge: r.badge,
      badgeNoun: r.badgeNoun,
      unread: r.unread,
      note: r.note,
      live: r.live,
      liveAtEnd: true,
      dim: d.status !== "live" || d.reachable === false,
      flags: (
        <HomeMark
          row={{ home: d.home, home_name: d.home_name, reachable: d.reachable }}
          agentHome={d.agent_id ? homes?.of(d.agent_id)?.mac : null}
          here={homes?.here}
        />
      ),
      launch: launchOf(d.scope),
      actions:
        pinnable || archivable ? (
          <ChatRowActions desk={d} pinnable={pinnable} archivable={archivable} connected={connected} onPin={onPin} onArchive={onArchive} />
        ) : undefined,
    };
  };
  const contentRows: ContentRow[] = [
    ...(drafting ? [{ id: NEW_ROW, lead: <ListIcon name="compose" />, title: "New Chat", label: "New chat, not started yet" }] : []),
    ...rows.map(chatRow),
  ];

  return (
    <>
      <div ref={wrapRef} className="loki-sidebar-body" onScrollCapture={measure}>
        <ContentList
          ref={ref}
          key={`${source.id}:${stateFilter?.state ?? "all"}`}
          label={source.title}
          title={source.title}
          rows={contentRows}
          selectedId={drafting ? NEW_ROW : selected}
          onSelect={(id) => {
            if (id !== NEW_ROW) onSelect(id);
          }}
          onEnter={(id) => onEnter(id === NEW_ROW ? null : id)}
          onMenu={(id, e) => {
            if (id !== NEW_ROW) openMenu(id, e);
          }}
          empty={emptyFor(source)}
          newAction={onNew && { label: "New Chat", run: () => onNew(source.agentId), keys: keyFor("desk.new") }}
          scope={stateFilter && <FilterPills pills={STATE_PILLS} value={stateFilter.state} onValue={stateFilter.onState} />}
          query={query}
          onQuery={shown ? onQuery : undefined}
        />
        {pills.up && (
          <button
            type="button"
            className="loki-sidebar-pill loki-sidebar-pill--up"
            style={{ top: pills.top + 8 }}
            onClick={() => reveal(pills.up)}
            aria-label="Scroll up to a chat that needs you"
          >
            <span aria-hidden>
              <Glyph icon={ArrowUpIcon} size={12} inline />
            </span>{" "}
            Needs you
          </button>
        )}
        {pills.down && (
          <button
            type="button"
            className="loki-sidebar-pill loki-sidebar-pill--down"
            onClick={() => reveal(pills.down)}
            aria-label="Scroll down to a chat that needs you"
          >
            <span aria-hidden>
              <Glyph icon={ArrowDownIcon} size={12} inline />
            </span>{" "}
            Needs you
          </button>
        )}
      </div>
      {menu && (
        <RowMenu
          {...menu}
          item={itemOf(menu.desk)}
          connected={connected}
          onClose={() => setMenu(null)}
          onOpen={onEnter}
          onPin={onPin}
          onArchive={onArchive}
          onRename={setRenaming}
          onMove={onMove && folders ? setMoving : undefined}
          onLabels={labels ? setLabeling : undefined}
          onDone={onDone}
          targets={macs ? moveTargets(menu.desk, macs.view) : []}
          onMoveTo={macs?.move}
        />
      )}
      {labeling && labels && (
        <LabelsDialog
          title={labeling.title ?? labeling.agent_name ?? "Chat"}
          current={desks.find((x) => x.scope === labeling.scope)?.labels ?? labeling.labels ?? []}
          list={labels.list}
          onChange={(next) => labels.set(labeling, next)}
          onClose={() => setLabeling(null)}
        />
      )}
      {renaming && (
        <RenameDesk
          name={renaming.title ?? ""}
          onClose={() => setRenaming(null)}
          onRename={(name) => onRename(renaming, name)}
          purpose={desks.find((x) => x.scope === renaming.scope)?.purpose ?? renaming.purpose}
          onPurpose={onPurpose ? (purpose) => onPurpose(renaming, purpose) : undefined}
        />
      )}
      {moving && onMove && folders && moving.agent_id && moving.conversation_id && (
        <ChangeFolder
          onClose={() => setMoving(null)}
          agentId={moving.agent_id}
          agentName={moving.agent_name}
          conversationKey={conversationDirName(moving.conversation_id, moving.agent_id)}
          title={moving.title}
          folders={folders}
          onMove={(folder) => onMove(moving, folder)}
        />
      )}
    </>
  );
}

interface RowMenuProps {
  desk: DeskSummary;
  item: AttentionItem | null;
  connected: boolean;
  onRename: (d: DeskSummary) => void;
  onMove?: (d: DeskSummary) => void;
  onLabels?: (d: DeskSummary) => void;
  targets: MoveTarget[];
  onMoveTo?: (d: DeskSummary, to: MoveTarget) => void;
  onOpen: (scope: string) => void;
  onPin: ChatListProps["onPin"];
  onArchive: ChatListProps["onArchive"];
  onDone?: ChatListProps["onDone"];
}

export function rowMenuEntries({
  desk: d,
  item,
  connected,
  onOpen,
  onPin,
  onArchive,
  onRename,
  onMove,
  onLabels,
  onDone,
  targets,
  onMoveTo,
}: RowMenuProps): MenuEntry[] {
  const archived = d.status === "archived";
  const done = doneAction(item);
  const off = (reason: string) => (connected ? {} : { disabled: true, hint: reason });
  return [
    { type: "item", id: "open", label: "Open", run: () => onOpen(d.scope) },
    ...(onDone && item && done
      ? [
          {
            type: "item",
            id: "done",
            label: done === "done" ? "Mark as Read" : "Mark as Unread",
            icon: done === "done" ? MailOpenIcon : MailDotIcon,
            run: () => onDone(item, done === "done"),
          } as const,
        ]
      : []),
    { type: "separator" },
    ...(canRename(d) ? [{ type: "item", id: "rename", label: "Rename…", icon: PencilIcon, run: () => onRename(d), ...off(NO_RENAME_REASON) } as const] : []),
    ...(onMove && canMove(d)
      ? [{ type: "item", id: "folder", label: "Change Folder…", icon: FolderIcon, run: () => onMove(d), ...off(NO_MOVE_REASON) } as const]
      : []),
    ...(onLabels && canLabel(d)
      ? [{ type: "item", id: "labels", label: "Labels…", icon: TagIcon, run: () => onLabels(d), ...off(NO_LABEL_REASON) } as const]
      : []),
    ...(onMoveTo
      ? targets.map((t): MenuEntry => ({
          type: "item",
          id: `move-${t.mac_id}`,
          label: `Move to ${t.name}`,
          run: () => onMoveTo(d, t),
          ...(!connected ? { disabled: true, hint: NO_MOVE_REASON } : !t.reachable ? { disabled: true, hint: `${t.name} is out of reach` } : {}),
        }))
      : []),
    { type: "separator" },
    ...(canPin(d)
      ? [{ type: "item", id: "pin", label: d.pinned ? "Unpin" : "Pin", icon: d.pinned ? PinOffIcon : PinIcon, run: () => onPin(d, !d.pinned) } as const]
      : []),
    ...(canArchive(d)
      ? [
          {
            type: "item",
            id: "archive",
            label: archived ? "Restore" : "Archive",
            icon: archived ? ArchiveRestoreIcon : ArchiveIcon,
            run: () => onArchive(d, !archived),
            ...off(NO_ARCHIVE_REASON),
          } as const,
        ]
      : []),
  ];
}

function RowMenu({ x, y, onClose, ...props }: RowMenuProps & { x: number; y: number; onClose: () => void }) {
  const d = props.desk;
  return (
    <DrawnMenu
      label={`${d.title ?? "Chat"} actions`}
      entries={rowMenuEntries(props)}
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      at={{ x, y }}
      opener={() => document.querySelector<HTMLElement>(`[data-launch="${CSS.escape(launchOf(d.scope))}"]`)}
      width={220}
    />
  );
}

export function ChatListView({
  desk,
  catchUp,
  notice,
  onNew,
  ...list
}: Pick<ChatListProps, "rows" | "stateFilter" | "source" | "selected" | "shown" | "onSelect" | "onEnter" | "query" | "onQuery" | "drafting" | "ref"> & {
  desk: Desk;
  catchUp: CatchUp;
  notice: (m: string) => void;
  onNew: (agentId: string | null) => void;
}) {
  return (
    <ChatList
      {...list}
      labels={{
        list: catchUp.labels.list,
        set: async (d, next) => {
          if (!d.agent_id || !d.conversation_id) return "no conversation";
          const err = await catchUp.labels.set({ agent_id: d.agent_id, conversation_id: d.conversation_id }, next);
          if (!err) desk.desks.request();
          return err;
        },
      }}
      desks={desk.desks.list}
      items={catchUp.items}
      connected={catchUp.status === "open"}
      onNew={desk.attention.available ? onNew : undefined}
      onPin={(d, pinned) => {
        if (d.agent_id && d.conversation_id) desk.desks.pin(d.agent_id, d.conversation_id, pinned);
      }}
      onRename={renameDesk(desk, catchUp, notice)}
      onPurpose={savePurpose(desk, catchUp)}
      folders={desk.attention.folders}
      onMove={async (d, folder) => {
        if (!d.agent_id || !d.conversation_id) return "no conversation";
        const err = await catchUp.changeFolder({ agent_id: d.agent_id, conversation_id: d.conversation_id }, folder);
        if (!err) notice(`${d.title ?? "chat"} moved to ${folder.replace(/^\/Users\/[^/]+/, "~")}`);
        return err;
      }}
      homes={homesOf(desk.macs.view, catchUp.agents)}
      macs={{
        view: desk.macs.view,
        move: (d, to) => {
          if (!d.agent_id || !d.conversation_id) return;
          const name = d.title ?? "chat";
          notice(`moving ${name} to ${to.name}…`);
          void desk.macs.move(d.agent_id, d.conversation_id, to.mac_id).then((err) => {
            notice(err ? `move: ${err}` : `${name} moved to ${to.name}`);
            if (!err) desk.desks.request();
          });
        },
      }}
      onDone={(item, done) => (done ? catchUp.seen(item) : catchUp.unread(item))}
      onArchive={(d, archived) => {
        if (!d.conversation_id) return;
        void catchUp.archiveConversation(d.conversation_id, archived, "sidebar", d.agent_id ?? undefined).then((err) => {
          if (err) return notice(`archive: ${err}`);
          notice(`${d.title ?? d.scope} ${archived ? "archived" : "restored"}`);
          desk.desks.request();
        });
      }}
    />
  );
}

const STATE_PILL: Record<ChatState, { label: string; icon: LucideIcon }> = {
  all: { label: "All", icon: MessagesSquareIcon },
  waiting: { label: "Waiting", icon: BellIcon },
  unread: { label: "Unread", icon: CircleDotIcon },
  working: { label: "Working", icon: ActivityIcon },
};

const STATE_PILLS: ReadonlyArray<FilterPill<ChatState>> = CHAT_STATES.map((value) => ({ value, ...STATE_PILL[value] }));

export type Homes = NonNullable<ChatListProps["homes"]>;

export function homesOf(macs: Pushes["peers"] | null, agents: ReadonlyArray<{ id: string; home_mac?: string | null }>): ChatListProps["homes"] {
  if (!macs?.peers.length) return undefined;
  const names = new Map([[macs.me.mac_id, macs.me.name], ...macs.peers.map((p) => [p.mac_id, p.name] as const)]);
  return {
    here: macs.me.mac_id,
    of: (agentId) => {
      const mac = agents.find((a) => a.id === agentId)?.home_mac ?? macs.me.mac_id;
      return { mac, name: names.get(mac) ?? "another Mac" };
    },
  };
}

function ChatRowActions({
  desk: d,
  pinnable,
  archivable,
  connected,
  onPin,
  onArchive,
}: { desk: DeskSummary; pinnable: boolean; archivable: boolean; connected: boolean } & Pick<ChatListProps, "onPin" | "onArchive">) {
  const pinned = !!d.pinned;
  const archived = d.status === "archived";
  const archiveTitle = archived ? "Restore from the archive" : "Archive";
  return (
    <>
      {pinnable && (
        <IconButton size={24} label={pinned ? "Unpin" : "Pin"} title={pinned ? "Unpin" : "Pin to the top"} onClick={() => onPin(d, !pinned)}>
          <Icon name="pin" size={14} />
        </IconButton>
      )}
      {archivable && (
        <IconButton
          size={24}
          label={archived ? "Restore" : "Archive"}
          title={connected ? archiveTitle : NO_ARCHIVE_REASON}
          disabled={!connected}
          onClick={() => onArchive(d, !archived)}
        >
          <Icon name={archived ? "history" : "archive"} size={14} />
        </IconButton>
      )}
    </>
  );
}
