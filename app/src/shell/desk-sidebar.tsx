import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Button, Field, IconButton, ListRow, ListSection } from "../components";
import { ago } from "../shared/ago";
import { Icon } from "../shared/icons";
import type { AttentionItem } from "../../../core/attention/model.ts";

import { AgentFace } from "../desk/agent-chip";
import { avatarUrl } from "../desk/env";
import { ColumnHeader } from "./list-column";
import {
  canArchive,
  canMove,
  canLabel,
  canPin,
  canRename,
  doneAction,
  loadSidebar,
  moveTargets,
  offscreenWaits,
  saveSidebar,
  sidebarModel,
  toggleFold,
  type MoveTarget,
  type SidebarPref,
  type SidebarRow,
} from "./sidebar-model";
import type { CatchUp, Desk } from "./types";
import { NO_RENAME_REASON, RenameDesk, renameDesk, savePurpose } from "../desk/rename-desk";
import { ChangeFolder, type FolderApi } from "../desk/new-desk";
import { conversationDirName } from "../../../core/desk-core.ts";
import { HomeMark } from "./home-mark";
import { prefersReducedMotion } from "../kit/motion";
import "./desk-sidebar.css";
import { popUpMenu, useNativeMenus, type MenuEntry } from "./native-menu";
import { MenuItems, menuKey } from "./menu-items";
import type { DeskSummary } from "../../../core/frame-types.ts";
import type { Pushes } from "../../../core/frames.ts";
import type { LabelView } from "../../../core/labels.ts";
import { LabelsDialog } from "../chat/labels";

/** The row's data-launch, so the pills can find a waiting row in the list. */
const launchOf = (scope: string) => `desk:${scope}`;
const ARCHIVED = "archived";

/** Filtering opens every fold, so a match is never hidden behind one. */
function isFolded(pref: SidebarPref, filtering: boolean, id: string): boolean {
  return !filtering && (id === ARCHIVED ? !pref.archivedOpen : pref.collapsed.includes(id));
}

const NO_ARCHIVE_REASON = "Archiving needs loki's daemon, which is not connected";
const NO_MOVE_REASON = "Changing folder needs loki's daemon, which is not connected";
const NO_LABEL_REASON = "Labels need loki's daemon, which is not connected";

/** localStorage, or nothing (a blocked store only costs the folds and the scroll). */
const store = (): Pick<Storage, "getItem" | "setItem"> | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

/** The props of the Chats sidebar (`DeskSidebar`): the chats, agents and Inbox items it lists, the chat on show, and what its rows and menus can do. */
export interface DeskSidebarProps {
  desks: DeskSummary[];
  agents: Array<{ id: string; name: string }>;
  items: AttentionItem[];
  current: string;
  /** The link to loki's daemon is up; archive and restore wait for it. */
  connected: boolean;
  onOpen: (scope: string) => void;
  /** Start a new desk, with this agent or (null) chosen in the sheet; left out while the daemon is off. */
  onNew?: (agentId: string | null) => void;
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
  /** An agent's face (desk/env avatarUrl); a prop so the list renders without a window. */
  avatar: (agentId: string) => string | null;
  /**
   * The filter, when the window holds it (a label chip or ⌘K sets it to `label:<name>`); left out, the sidebar keeps
   * its own.
   */
  query?: string;
  onQuery?: (query: string) => void;
  /** Labels on chats (plan 022): the list chips take their colours from, and saving a chat's labels; left out, no Labels…. */
  labels?: { list: LabelView[] | null; set: (desk: DeskSummary, labels: string[]) => Promise<string | null> };
  /**
   * Where agents live, once Macs are paired (plan 023): this Mac's id, and each agent's home and its name. Each agent's
   * section says it once; a row marks only a chat living elsewhere or one whose Mac is asleep.
   */
  homes?: { here: string; of: (agentId: string) => { mac: string; name: string } | null };
  /** This Mac and the Macs paired with it, and moving a chat to one (plan 023, addendum A1); left out, no Move to. */
  macs?: { view: Pushes["peers"] | null; move: (desk: DeskSummary, to: MoveTarget) => void };
}

/**
 * The Desk column, Slack's channel sidebar (plan 013 U4): a "Desks" header with new desk, a filter, then
 * Pinned and one folding section per agent (sidebar-model.ts), the archive folded at the bottom. A row opens its
 * desk; hover buttons and the row's context menu pin and archive. When a desk that needs you is scrolled
 * out of sight, a pill at that edge says so and brings it into view. Folds and scroll outlive restarts.
 */
export function DeskSidebar({
  desks,
  agents,
  items,
  current,
  connected,
  onOpen,
  onNew,
  onPin,
  onArchive,
  onRename,
  onPurpose,
  onMove,
  folders,
  onDone,
  avatar,
  query: heldQuery,
  onQuery,
  labels,
  macs,
  homes,
}: DeskSidebarProps) {
  const [ownQuery, setOwnQuery] = useState("");
  const query = heldQuery ?? ownQuery;
  const setQuery = onQuery ?? setOwnQuery;
  const [pref, setPref] = useState<SidebarPref>(() => {
    const s = store();
    return s ? loadSidebar(s) : { collapsed: [], archivedOpen: false, scroll: 0 };
  });
  const [menu, setMenu] = useState<{ desk: DeskSummary; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<DeskSummary | null>(null);
  const [moving, setMoving] = useState<DeskSummary | null>(null);
  const [labeling, setLabeling] = useState<DeskSummary | null>(null);
  const [pills, setPills] = useState<{ up: string | null; down: string | null }>({ up: null, down: null });
  const scrollRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
  /** The scroll kept from last time, put back once the desks have arrived. */
  const savedScroll = useRef(pref.scroll);

  const model = useMemo(() => sidebarModel(desks, items, { query, current, agents }), [desks, items, query, current, agents]);
  const filtering = query.trim() !== "";
  const folded = (id: string) => isFolded(pref, filtering, id);
  const waiting = useMemo(
    () => model.sections.filter((s) => !isFolded(pref, filtering, s.id)).flatMap((s) => s.rows.filter((r) => r.kind === "waits").map((r) => r.desk.scope)),
    [model, pref, filtering],
  );

  useEffect(() => {
    const s = store();
    if (s) saveSidebar(s, pref);
  }, [pref]);
  const fold = (id: string) => setPref((p) => (id === ARCHIVED ? { ...p, archivedOpen: !p.archivedOpen } : toggleFold(p, id)));

  // The pills: where each waiting row sits against the visible band of the list.
  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const rows = waiting.flatMap((scope) => {
      const r = el.querySelector<HTMLElement>(`[data-launch="${CSS.escape(launchOf(scope))}"]`)?.getBoundingClientRect();
      return r ? [{ id: scope, top: r.top - box.top + el.scrollTop, bottom: r.bottom - box.top + el.scrollTop }] : [];
    });
    const next = offscreenWaits(rows, { top: el.scrollTop, bottom: el.scrollTop + el.clientHeight });
    setPills((p) => (p.up === next.up && p.down === next.down ? p : next));
  }, [waiting]);
  useLayoutEffect(measure, [measure, model]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  // The kept scroll goes back once the desks have arrived, and is kept again a beat after each scroll.
  const restored = useRef(false);
  const hasRows = model.sections.length > 0;
  useLayoutEffect(() => {
    if (restored.current || !hasRows || !scrollRef.current) return;
    restored.current = true;
    scrollRef.current.scrollTop = savedScroll.current;
  }, [hasRows]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );
  const onScroll = () => {
    measure();
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const el = scrollRef.current;
      if (el && restored.current) setPref((p) => ({ ...p, scroll: el.scrollTop }));
    }, 250);
  };

  const reveal = (scope: string | null) => {
    if (!scope) return;
    const row = scrollRef.current?.querySelector<HTMLElement>(`[data-launch="${CSS.escape(launchOf(scope))}"]`);
    row?.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    row?.focus({ preventScroll: true });
  };

  /** The Mac an agent lives on, in its section's header, once Macs are paired. */
  const homeAside = (agentId: string) => {
    const home = homes?.of(agentId);
    return home ? (
      <span title={`${home.name}: where this agent's chats start`} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        <Icon name="laptop" size={12} />
        {home.name}
      </span>
    ) : undefined;
  };

  // The rows' handlers stay the same functions from render to render and look the chat up when called, so a row
  // redraws only when what it shows changed (plan 051): one chat moving no longer redraws the whole list.
  const native = useNativeMenus();
  // Under Liquid Glass in the Mac app the row's menu is the system's, popped up at the pointer (U19).
  const popRow = (d: DeskSummary, x: number, y: number) =>
    void popUpMenu(
      rowMenuEntries({
        desk: d,
        item: items.find((i) => i.agent_id === d.agent_id && i.id === d.conversation_id) ?? null,
        connected,
        onOpen,
        onPin,
        onArchive,
        onRename: setRenaming,
        onMove: onMove && folders ? setMoving : undefined,
        onLabels: labels ? setLabeling : undefined,
        onDone,
        targets: macs ? moveTargets(d, macs.view) : [],
        onMoveTo: macs?.move,
      }),
      { x, y },
    ).catch((e: unknown) => console.warn("loki: row menu", e));
  const latest = useRef({ desks, onOpen, onPin, onArchive, native, popRow });
  useEffect(() => {
    latest.current = { desks, onOpen, onPin, onArchive, native, popRow };
  });
  const deskOf = (scope: string) => latest.current.desks.find((d) => d.scope === scope);
  const openRow = useCallback((scope: string) => latest.current.onOpen(scope), []);
  const menuRow = useCallback((scope: string, x: number, y: number) => {
    const d = deskOf(scope);
    if (!d) return;
    if (latest.current.native) latest.current.popRow(d, x, y);
    else setMenu({ desk: d, x, y });
  }, []);
  const pinRow = useCallback((scope: string, pinned: boolean) => {
    const d = deskOf(scope);
    if (d) latest.current.onPin(d, pinned);
  }, []);
  const archiveRow = useCallback((scope: string, archived: boolean) => {
    const d = deskOf(scope);
    if (d) latest.current.onArchive(d, archived);
  }, []);

  const rowOf = (r: SidebarRow) => {
    const d = r.desk;
    return (
      <ChatRow
        key={d.scope}
        scope={d.scope}
        title={d.title ?? (r.main ? "Main chat" : d.status === "live" ? "New chat" : d.scope)}
        time={ago(d.last_active)}
        badge={r.badge}
        badgeNoun={r.badgeNoun}
        unread={r.unread}
        note={r.note}
        live={r.live}
        current={r.current}
        dim={d.status !== "live" || d.reachable === false}
        pinnable={canPin(d)}
        pinned={!!d.pinned}
        archivable={canArchive(d)}
        archived={d.status === "archived"}
        connected={connected}
        home={d.home}
        homeName={d.home_name}
        reachable={d.reachable}
        agentHome={d.agent_id ? homes?.of(d.agent_id)?.mac : null}
        here={homes?.here}
        onOpen={openRow}
        onMenu={menuRow}
        onPin={pinRow}
        onArchive={archiveRow}
      />
    );
  };

  const onFieldKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape" && query) {
      e.preventDefault();
      e.stopPropagation();
      setQuery("");
    } else if (e.key === "Enter") {
      const first = model.sections.at(0)?.rows.at(0) ?? model.archived.at(0);
      if (first) {
        e.preventDefault();
        onOpen(first.desk.scope);
      }
    } else if (e.key === "ArrowDown") {
      const row = scrollRef.current?.querySelector<HTMLElement>(".loki-list-row");
      if (row) {
        e.preventDefault();
        row.focus();
      }
    }
  };

  // ↑↓ between the rows, as from the filter into the first: one key per desk instead of a Tab through each row's actions. ↑ from the first row goes back to the filter.
  const onRowsKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.key !== "ArrowDown" && e.key !== "ArrowUp") || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const target = e.target as HTMLElement;
    if (!target.classList.contains("loki-list-row")) return;
    const rows = [...(scrollRef.current?.querySelectorAll<HTMLElement>(".loki-list-row") ?? [])];
    const i = rows.indexOf(target);
    const next = e.key === "ArrowDown" ? rows[i + 1] : i > 0 ? rows[i - 1] : fieldRef.current;
    if (!next) return;
    e.preventDefault();
    next.focus();
  };

  return (
    <>
      <ColumnHeader
        title="Chats"
        actions={
          onNew && (
            <IconButton label="New chat" title="New chat" onClick={() => onNew(null)}>
              <Icon name="plus" size={16} />
            </IconButton>
          )
        }
      />
      <div className="loki-sidebar-filter">
        <Field
          ref={fieldRef}
          size="sm"
          type="search"
          name="desk-filter"
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          data-form-type="other"
          placeholder="Find a chat…"
          aria-label="Find a chat"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onFieldKey}
        />
      </div>
      <div className="loki-sidebar-body">
        <div ref={scrollRef} className="loki-column-scroll" onScroll={onScroll} onKeyDown={onRowsKey}>
          {model.sections.map((s) => {
            const shut = folded(s.id);
            return (
              <ListSection
                key={s.id}
                title={s.title}
                icon={s.id === "pinned" ? "pin" : undefined}
                // The agent's face heads its section; its chats, the main one included, are plain rows.
                face={s.agentId ? <AgentFace name={s.title} src={avatar(s.agentId)} size={16} /> : undefined}
                // Folded, the section still says how many of its desks need you.
                count={shut ? s.waiting : null}
                aside={s.agentId ? homeAside(s.agentId) : undefined}
                open={!shut}
                onToggle={filtering ? undefined : () => fold(s.id)}
                actions={
                  onNew && s.agentId ? (
                    <IconButton size={24} label={`New chat with ${s.title}`} title={`New chat with ${s.title}`} onClick={() => onNew(s.agentId)}>
                      <Icon name="plus" size={14} />
                    </IconButton>
                  ) : undefined
                }
              >
                {s.rows.map((r) => rowOf(r))}
              </ListSection>
            );
          })}
          {model.archived.length > 0 && (
            <ListSection
              title="Archived"
              icon="archive"
              count={model.archived.length}
              open={!folded(ARCHIVED)}
              onToggle={filtering ? undefined : () => fold(ARCHIVED)}
            >
              {model.archived.map((r) => rowOf(r))}
            </ListSection>
          )}
          {model.empty && (
            <div role="status" className="loki-sidebar-empty">
              <span className="loki-meta loki-meta--wrap">No chats match “{query.trim()}”.</span>
              <Button
                onClick={() => {
                  setQuery("");
                  fieldRef.current?.focus();
                }}
              >
                Clear filter
              </Button>
            </div>
          )}
          {!filtering && !hasRows && model.archived.length === 0 && (
            <div className="loki-sidebar-empty">
              <span className="loki-meta loki-meta--wrap">No chats yet.</span>
              {onNew && <Button onClick={() => onNew(null)}>New chat</Button>}
            </div>
          )}
        </div>
        {pills.up && (
          <button
            type="button"
            className="loki-sidebar-pill loki-sidebar-pill--up"
            onClick={() => reveal(pills.up)}
            aria-label="Scroll up to a chat that needs you"
          >
            <span aria-hidden>↑</span> Needs you
          </button>
        )}
        {pills.down && (
          <button
            type="button"
            className="loki-sidebar-pill loki-sidebar-pill--down"
            onClick={() => reveal(pills.down)}
            aria-label="Scroll down to a chat that needs you"
          >
            <span aria-hidden>↓</span> Needs you
          </button>
        )}
      </div>
      {menu && (
        <RowMenu
          {...menu}
          item={items.find((i) => i.agent_id === menu.desk.agent_id && i.id === menu.desk.conversation_id) ?? null}
          connected={connected}
          onClose={() => setMenu(null)}
          onOpen={onOpen}
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

/** What a row's menu offers, as data (U19): drawn by RowMenu, or popped up natively under Liquid Glass in the Mac app. */
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
  onOpen: DeskSidebarProps["onOpen"];
  onPin: DeskSidebarProps["onPin"];
  onArchive: DeskSidebarProps["onArchive"];
  onDone?: DeskSidebarProps["onDone"];
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
      ? [{ type: "item", id: "done", label: done === "done" ? "Mark as Read" : "Mark as Unread", run: () => onDone(item, done === "done") } as const]
      : []),
    { type: "separator" },
    ...(canRename(d) ? [{ type: "item", id: "rename", label: "Rename…", run: () => onRename(d), ...off(NO_RENAME_REASON) } as const] : []),
    ...(onMove && canMove(d) ? [{ type: "item", id: "folder", label: "Change Folder…", run: () => onMove(d), ...off(NO_MOVE_REASON) } as const] : []),
    ...(onLabels && canLabel(d) ? [{ type: "item", id: "labels", label: "Labels…", run: () => onLabels(d), ...off(NO_LABEL_REASON) } as const] : []),
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
    ...(canPin(d) ? [{ type: "item", id: "pin", label: d.pinned ? "Unpin" : "Pin", run: () => onPin(d, !d.pinned) } as const] : []),
    ...(canArchive(d)
      ? [{ type: "item", id: "archive", label: archived ? "Restore" : "Archive", run: () => onArchive(d, !archived), ...off(NO_ARCHIVE_REASON) } as const]
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
 * The sidebar wired to the window's models, as the tree drawer it replaced was: pin through the mod,
 * archive through loki's daemon and then a fresh desks list, each with a notice.
 */
export function DeskSidebarView({
  desk,
  catchUp,
  notice,
  onOpen,
  onNew,
  query,
  onQuery,
  drafting = false,
}: {
  desk: Desk;
  catchUp: CatchUp;
  notice: (m: string) => void;
  onOpen: (scope: string) => void;
  onNew: (agentId: string | null) => void;
  query: string;
  onQuery: (query: string) => void;
  /** A chat not started yet shows in the pane (⌘N under Liquid Glass): no row is the open one. */
  drafting?: boolean;
}) {
  const connected = catchUp.status === "open";
  return (
    <DeskSidebar
      query={query}
      onQuery={onQuery}
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
      agents={catchUp.agents}
      items={catchUp.items}
      current={drafting ? "" : desk.scope}
      connected={connected}
      avatar={avatarUrl}
      onOpen={onOpen}
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
export type Homes = NonNullable<DeskSidebarProps["homes"]>;

/** Where each agent lives, by Mac name, once another Mac is paired; none before (one Mac needs no saying). The phone's Home reads it too. */
export function homesOf(macs: Pushes["peers"] | null, agents: ReadonlyArray<{ id: string; home_mac?: string | null }>): DeskSidebarProps["homes"] {
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

/** One chat's row in the list, as plain values and handlers that take its scope (see DeskSidebar's rowOf). */
interface ChatRowProps {
  scope: string;
  title: string;
  time: string;
  badge: number | null;
  badgeNoun?: string;
  unread: boolean;
  note?: string;
  live: boolean;
  current: boolean;
  dim: boolean;
  pinnable: boolean;
  pinned: boolean;
  archivable: boolean;
  archived: boolean;
  connected: boolean;
  home?: string;
  homeName?: string;
  reachable?: boolean;
  agentHome?: string | null;
  here?: string;
  onOpen: (scope: string) => void;
  onMenu: (scope: string, x: number, y: number) => void;
  onPin: (scope: string, pinned: boolean) => void;
  onArchive: (scope: string, archived: boolean) => void;
}

/** A row's pin and archive buttons, shown on hover; the row leaves them out when the chat can be neither. */
function ChatRowActions(p: Pick<ChatRowProps, "scope" | "pinnable" | "pinned" | "archivable" | "archived" | "connected" | "onPin" | "onArchive">) {
  const archiveTitle = p.archived ? "Restore from the archive" : "Archive";
  return (
    <>
      {p.pinnable && (
        <IconButton size={24} label={p.pinned ? "Unpin" : "Pin"} title={p.pinned ? "Unpin" : "Pin to the top"} onClick={() => p.onPin(p.scope, !p.pinned)}>
          <Icon name="pin" size={14} />
        </IconButton>
      )}
      {p.archivable && (
        <IconButton
          size={24}
          label={p.archived ? "Restore" : "Archive"}
          title={p.connected ? archiveTitle : NO_ARCHIVE_REASON}
          disabled={!p.connected}
          onClick={() => p.onArchive(p.scope, !p.archived)}
        >
          <Icon name={p.archived ? "history" : "archive"} size={14} />
        </IconButton>
      )}
    </>
  );
}

/** A chat's row, drawn again only when one of its own values changes (plan 051). */
const ChatRow = memo(function ChatRow(p: ChatRowProps) {
  return (
    <ListRow
      title={p.title}
      // When it last spoke; the badge or the live dot takes its place while something waits or runs.
      time={p.time}
      // One mark at most beside the name, and only where it differs from its section (the status is on the right).
      flags={<HomeMark row={{ home: p.home, home_name: p.homeName, reachable: p.reachable }} agentHome={p.agentHome} here={p.here} />}
      badge={p.badge}
      badgeNoun={p.badgeNoun}
      unread={p.unread}
      note={p.note}
      live={p.live}
      liveAtEnd
      current={p.current}
      dim={p.dim}
      launch={launchOf(p.scope)}
      onOpen={() => p.onOpen(p.scope)}
      onMenu={(e: MouseEvent<HTMLButtonElement>) => {
        const box = e.currentTarget.getBoundingClientRect();
        // A mouse gives the pointer; the context-menu key gives 0,0, so the menu hangs from the row.
        p.onMenu(p.scope, e.clientX || box.left + 24, e.clientY || box.bottom);
      }}
      actions={p.pinnable || p.archivable ? <ChatRowActions {...p} /> : undefined}
    />
  );
});
