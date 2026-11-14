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
import { MenuItems, menuKey } from "./menu-items";
import type { DeskSummary } from "../../../core/frame-types.ts";
import type { Pushes } from "../../../core/frames.ts";
import type { LabelView } from "../../../core/labels.ts";
import { LabelsDialog } from "../chat/labels";

/** The row's data-launch, so the pills and a closed menu can find a chat's row in the list. */
const launchOf = (scope: string) => `desk:${scope}`;
/** The id of the New Chat row a chat being started puts at the top; no chat's scope starts with a colon. */
const NEW_ROW = ":new";

const NO_ARCHIVE_REASON = "Archiving needs loki's daemon, which is not connected";
const NO_MOVE_REASON = "Changing folder needs loki's daemon, which is not connected";
const NO_LABEL_REASON = "Labels need loki's daemon, which is not connected";

/** The sentence an empty source shows (KTD3). */
function emptyFor(source: Pick<ChatSource, "id" | "title">): string {
  if (source.id === ALL_CHATS) return "No chats yet.";
  if (source.id === PINNED_CHATS) return "No pinned chats.";
  if (source.id === ARCHIVED_CHATS) return "No archived chats.";
  return `No chats with ${source.title} yet.`;
}

/** The props of the Chats list (`ChatList`): the source and its rows, the chat selected, and what its rows and menus can do. */
export interface ChatListProps {
  /** The source's rows, Search applied (sidebar-model.ts sourceRows). */
  rows: SourceRow[];
  /** The source chosen in the sidebar. */
  source: Pick<ChatSource, "id" | "title" | "agentId">;
  /** The chat committed in this list, or null when the source does not hold the one open (KTD8). */
  selected: string | null;
  /** Chats is the place showing. Hidden, the list stays mounted for its scroll but leaves ⌥⌘F to the list on screen. */
  shown: boolean;
  /** Every chat, for the dialogs to read a chat's latest labels and purpose. */
  desks: DeskSummary[];
  items: AttentionItem[];
  /** The link to loki's daemon is up; archive and restore wait for it. */
  connected: boolean;
  /** Commit a chat: an arrow's rest, a click, or ⌘[ ⌘]. It shows in the detail; focus stays in the list (KTD4). */
  onSelect: (scope: string) => void;
  /**
   * Return or Tab on the selected chat, or Open from its menu: focus goes into its message box. Null is the New Chat
   * row while one is being started: focus goes into the draft's box.
   */
  onEnter: (scope: string | null) => void;
  /** Start a new chat, with this agent or (null) chosen in the sheet; left out while the daemon is off. */
  onNew?: (agentId: string | null) => void;
  /**
   * A chat not started yet shows in the pane (⌘N, U20): the list leads with a New Chat row, the
   * selected one, as Messages leads with a new message.
   */
  drafting?: boolean;
  onPin: (desk: DeskSummary, pinned: boolean) => void;
  onArchive: (desk: DeskSummary, archived: boolean) => void;
  /** Save a new name; resolves to the daemon's error or null. The dialog stays open on an error. */
  onRename: (desk: DeskSummary, name: string) => Promise<string | null>;
  /** Save the chat's purpose line (plan 049, R11), an empty one clearing it; left out, the Rename dialog has no purpose field. */
  onPurpose?: (desk: DeskSummary, purpose: string) => Promise<string | null>;
  /** Move a chat to another folder; resolves to the daemon's refusal or null. Left out with folders, the menu has no Change folder…. */
  onMove?: (desk: DeskSummary, folder: string) => Promise<string | null>;
  /** The Mac's folders, for the Change folder dialog's field. */
  folders?: FolderApi;
  /** Done by hand, the Inbox's clear (true) and its undo (false); left out, the menu has neither. */
  onDone?: (item: AttentionItem, done: boolean) => void;
  /** The Search, held by the window so a label chip or ⌘K can set it to `label:<name>` (plan 022, R4). */
  query: string;
  onQuery: (query: string) => void;
  /** Labels on chats (plan 022): the list chips take their colours from, and saving a chat's labels; left out, no Labels…. */
  labels?: { list: LabelView[] | null; set: (desk: DeskSummary, labels: string[]) => Promise<string | null> };
  /**
   * Where agents live, once Macs are paired (plan 023): this Mac's id, and each agent's home and its name. A row marks
   * only a chat living elsewhere or one whose Mac is asleep.
   */
  homes?: { here: string; of: (agentId: string) => { mac: string; name: string } | null };
  /** This Mac and the Macs paired with it, and moving a chat to one (plan 023, addendum A1); left out, no Move to. */
  macs?: { view: Pushes["peers"] | null; move: (desk: DeskSummary, to: MoveTarget) => void };
  /** The list's handle, for the window's ⌘[ ⌘] to step the rows it draws. */
  ref?: Ref<ContentListHandle>;
}

/**
 * Chats' list (plan 2026-11-14-1330, U3), Mail's message list on ContentList: the source's name over Search and New
 * Chat, then one line per chat (R5), under agent headings when the source is every chat. The arrows highlight and
 * commit after a rest, which shows the chat without moving focus; Return or Tab goes into its message box. Hover
 * shows pin and archive, a right click the row's menu. When a chat that needs you is scrolled out of sight, a pill at
 * that edge says so and brings it into view.
 */
export function ChatList({
  rows,
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
  // The pills: where each waiting row sits against the visible band of the rows.
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

  // A chat selected from outside the list (⌘K, a notification, landing) is brought into view in it (R7).
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
    // A mouse gives the pointer; the context-menu key gives 0,0, so the menu hangs from the row.
    const x = e.clientX || box.left + 24;
    const y = e.clientY || box.bottom;
    // In the Mac app the row's menu is the system's, popped up at the pointer (U19).
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
      // When it last spoke; the badge or the live dot takes its place while something waits or runs.
      time: ago(d.last_active),
      badge: r.badge,
      badgeNoun: r.badgeNoun,
      unread: r.unread,
      note: r.note,
      live: r.live,
      liveAtEnd: true,
      dim: d.status !== "live" || d.reachable === false,
      // One mark at most beside the name, and only where it differs from its agent (the status is on the right).
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
    // The chat it stands for is already open in the pane; the row only shows where you are.
    ...(drafting ? [{ id: NEW_ROW, lead: <ListIcon name="compose" />, title: "New Chat", label: "New chat, not started yet" }] : []),
    ...rows.map(chatRow),
  ];

  return (
    <>
      <div ref={wrapRef} className="loki-sidebar-body" onScrollCapture={measure}>
        <ContentList
          ref={ref}
          key={source.id}
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
          query={query}
          // Hidden behind another place, the list keeps its Search but gives up ⌥⌘F.
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

/** What a row's menu offers, as data (U19): drawn by RowMenu, or popped up natively in the Mac app. */
interface RowMenuProps {
  desk: DeskSummary;
  item: AttentionItem | null;
  connected: boolean;
  onRename: (d: DeskSummary) => void;
  onMove?: (d: DeskSummary) => void;
  onLabels?: (d: DeskSummary) => void;
  /** The Macs this chat can move to (sidebar-model.ts moveTargets). */
  targets: MoveTarget[];
  onMoveTo?: (d: DeskSummary, to: MoveTarget) => void;
  /** Open: focus into the chat's message box (the right click has already selected it). */
  onOpen: (scope: string) => void;
  onPin: ChatListProps["onPin"];
  onArchive: ChatListProps["onArchive"];
  onDone?: ChatListProps["onDone"];
}

/**
 * A row's menu, Mail's way: open and read state, then what changes the chat (rename, folder, labels, another Mac),
 * then pin and archive, each group apart; only what the desk allows, and what needs the link off while it is down.
 */
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

/** A row's context menu drawn at the pointer, where no native menu pops up: rowMenuEntries. ↑↓ Enter Esc, or click; a press outside closes it. */
function RowMenu({ x, y, onClose, ...props }: RowMenuProps & { x: number; y: number; onClose: () => void }) {
  const d = props.desk;
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    const node = ref.current;
    node?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')?.focus();
    const away = (e: PointerEvent) => {
      if (!node?.contains(e.target as Node)) closeRef.current();
    };
    // capture phase: the rail, the list column and popovers stop pointerdown from bubbling, and a press there must still close it
    window.addEventListener("pointerdown", away, true);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      // Closed with Esc or a pick that moves focus nowhere: focus goes back to the desk's row, not the page.
      const a = document.activeElement;
      if (!a || a === document.body || node?.contains(a))
        document.querySelector<HTMLElement>(`[data-launch="${CSS.escape(launchOf(d.scope))}"]`)?.focus({ preventScroll: true });
    };
  }, [d.scope]);
  // Kept inside the window: a menu opened near the right or bottom edge moves in.
  const left = Math.min(x, (typeof window === "undefined" ? x : window.innerWidth) - 228);
  const top = Math.min(y, (typeof window === "undefined" ? y : window.innerHeight) - 236);
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`${d.title ?? "Chat"} actions`}
      className="loki-sidebar-menu"
      style={{ left: Math.max(8, left), top: Math.max(8, top) }}
      onKeyDown={(e) => menuKey(e, ref.current, onClose)}
    >
      <MenuItems entries={rowMenuEntries(props)} onPicked={onClose} />
    </div>
  );
}

/**
 * The Chats list wired to the window's models: pin through the mod, archive through loki's daemon and then a fresh
 * chats list, each with a notice.
 */
export function ChatListView({
  desk,
  catchUp,
  notice,
  onNew,
  ...list
}: Pick<ChatListProps, "rows" | "source" | "selected" | "shown" | "onSelect" | "onEnter" | "query" | "onQuery" | "drafting" | "ref"> & {
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

/** Where each agent lives and this Mac's id, as `homesOf` builds it. */
export type Homes = NonNullable<ChatListProps["homes"]>;

/** Where each agent lives, by Mac name, once another Mac is paired; none before (one Mac needs no saying). The phone's Home reads it too. */
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

/** A row's pin and archive buttons, shown on hover; the row leaves them out when the chat can be neither. */
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
