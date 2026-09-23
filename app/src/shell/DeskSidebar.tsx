import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Button, Field, IconButton, ListIcon, ListRow, ListSection, Row } from "../components";
import { Icon } from "../shared/icons";
import type { AttentionItem } from "../../../core/attention/model.ts";
import type { DeskSummary } from "../desk/useDesk";
import { AgentFace } from "../desk/AgentChip";
import { avatarUrl } from "../desk/env";
import { ColumnHeader } from "./ListColumn";
import { canArchive, canPin, loadSidebar, offscreenWaits, saveSidebar, sidebarModel, toggleFold, type SidebarPref, type SidebarRow } from "./sidebarModel";
import type { CatchUp, Desk } from "./types";
import "./deskSidebar.css";

/** The row's data-launch, so the pills can find a waiting row in the list. */
const launchOf = (scope: string) => `desk:${scope}`;
const ARCHIVED = "archived";
const NO_ARCHIVE_REASON = "Archiving needs the app-server, which is not connected";

/** localStorage, or nothing (a blocked store only costs the folds and the scroll). */
const store = (): Pick<Storage, "getItem" | "setItem"> | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

export interface DeskSidebarProps {
  desks: DeskSummary[];
  agents: Array<{ id: string; name: string }>;
  items: AttentionItem[];
  current: string;
  /** The app-server link is up; archive and restore wait for it. */
  connected: boolean;
  onOpen: (scope: string) => void;
  /** Start a new desk, with this agent or (null) chosen in the sheet; left out while the app-server is off. */
  onNew?: (agentId: string | null) => void;
  onPin: (desk: DeskSummary, pinned: boolean) => void;
  onArchive: (desk: DeskSummary, archived: boolean) => void;
  /** An agent's face (desk/env avatarUrl); a prop so the list renders without a window. */
  avatar: (agentId: string) => string | null;
}

/**
 * The Desk column, Slack's channel sidebar (plan 013 U4): a "Desks" header with new desk, a filter, then
 * Pinned and one folding section per agent (sidebarModel.ts), the archive folded at the bottom. A row opens its
 * desk; hover buttons and the row's context menu pin and archive. When a desk that needs you is scrolled
 * out of sight, a pill at that edge says so and brings it into view. Folds and scroll outlive restarts.
 */
export function DeskSidebar({ desks, agents, items, current, connected, onOpen, onNew, onPin, onArchive, avatar }: DeskSidebarProps) {
  const [query, setQuery] = useState("");
  const [pref, setPref] = useState<SidebarPref>(() => {
    const s = store();
    return s ? loadSidebar(s) : { collapsed: [], archivedOpen: false, scroll: 0 };
  });
  const [menu, setMenu] = useState<{ desk: DeskSummary; x: number; y: number } | null>(null);
  const [pills, setPills] = useState<{ up: string | null; down: string | null }>({ up: null, down: null });
  const scrollRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
  /** The scroll kept from last time, put back once the desks have arrived. */
  const savedScroll = useRef(pref.scroll);

  const model = useMemo(() => sidebarModel(desks, items, { query, current, agents }), [desks, items, query, current, agents]);
  const filtering = query.trim() !== "";
  /** Filtering opens every fold, so a match is never hidden behind one. */
  const folded = (id: string) => !filtering && (id === ARCHIVED ? !pref.archivedOpen : pref.collapsed.includes(id));
  const waiting = useMemo(() => model.sections.filter((s) => !folded(s.id)).flatMap((s) => s.rows.filter((r) => r.kind === "waits").map((r) => r.desk.scope)), [model, pref, filtering]); // eslint-disable-line react-hooks/exhaustive-deps

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
  useEffect(() => () => void (saveTimer.current && clearTimeout(saveTimer.current)), []);
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
    const reduced = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const row = scrollRef.current?.querySelector<HTMLElement>(`[data-launch="${CSS.escape(launchOf(scope))}"]`);
    row?.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
    row?.focus({ preventScroll: true });
  };

  const actionsFor = (d: DeskSummary) => {
    const pin = canPin(d);
    const archive = canArchive(d);
    if (!pin && !archive) return undefined;
    const archived = d.status === "archived";
    return (
      <>
        {pin && (
          <IconButton size={24} label={d.pinned ? "Unpin" : "Pin"} title={d.pinned ? "Unpin" : "Pin to the top"} onClick={() => onPin(d, !d.pinned)}>
            <Icon name="pin" size={14} />
          </IconButton>
        )}
        {archive && (
          <IconButton size={24} label={archived ? "Restore" : "Archive"} title={connected ? (archived ? "Restore from the archive" : "Archive") : NO_ARCHIVE_REASON} disabled={!connected} onClick={() => onArchive(d, !archived)}>
            <Icon name={archived ? "history" : "archive"} size={14} />
          </IconButton>
        )}
      </>
    );
  };

  const rowOf = (r: SidebarRow, inPinned: boolean) => {
    const d = r.desk;
    const name = d.title ?? (r.main ? "Main chat" : d.status === "live" ? "New desk" : d.scope);
    return (
      <ListRow
        key={d.scope}
        lead={r.main && !inPinned ? <AgentFace name={d.agentName} src={d.agentId ? avatar(d.agentId) : null} size={20} /> : <ListIcon name={d.status === "live" ? "desk" : "archive"} />}
        title={name}
        flags={d.pinned && !inPinned ? <Icon name="pin" size={12} title="pinned" /> : undefined}
        badge={r.badge}
        badgeNoun={r.badgeNoun}
        unread={r.unread}
        live={r.live}
        current={r.current}
        dim={d.status !== "live"}
        launch={launchOf(d.scope)}
        onOpen={() => onOpen(d.scope)}
        onMenu={(e: MouseEvent<HTMLButtonElement>) => {
          const box = e.currentTarget.getBoundingClientRect();
          // A mouse gives the pointer; the context-menu key gives 0,0, so the menu hangs from the row.
          setMenu({ desk: d, x: e.clientX || box.left + 24, y: e.clientY || box.bottom });
        }}
        actions={actionsFor(d)}
      />
    );
  };

  const onFieldKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape" && query) {
      e.preventDefault();
      e.stopPropagation();
      setQuery("");
    } else if (e.key === "Enter") {
      const first = model.sections[0]?.rows[0] ?? model.archived[0];
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

  return (
    <>
      <ColumnHeader
        title="Desks"
        actions={
          onNew && (
            <IconButton label="New desk" title="New desk" onClick={() => onNew(null)}>
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
          placeholder="Find a desk…"
          aria-label="Find a desk"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onFieldKey}
        />
      </div>
      <div className="loki-sidebar-body">
        <div ref={scrollRef} className="loki-column-scroll" onScroll={onScroll}>
          {model.sections.map((s) => {
            const shut = folded(s.id);
            return (
              <ListSection
                key={s.id}
                title={s.title}
                icon={s.id === "pinned" ? "pin" : undefined}
                // Folded, the section still says how many of its desks need you.
                count={shut ? s.waiting : null}
                open={!shut}
                onToggle={filtering ? undefined : () => fold(s.id)}
                actions={
                  onNew && s.agentId ? (
                    <IconButton size={24} label={`New desk with ${s.title}`} title={`New desk with ${s.title}`} onClick={() => onNew(s.agentId)}>
                      <Icon name="plus" size={14} />
                    </IconButton>
                  ) : undefined
                }
              >
                {s.rows.map((r) => rowOf(r, s.id === "pinned"))}
              </ListSection>
            );
          })}
          {model.archived.length > 0 && (
            <ListSection title="Archived" icon="archive" count={model.archived.length} open={!folded(ARCHIVED)} onToggle={filtering ? undefined : () => fold(ARCHIVED)}>
              {model.archived.map((r) => rowOf(r, false))}
            </ListSection>
          )}
          {model.empty && (
            <div role="status" className="loki-sidebar-empty">
              <span className="loki-meta loki-meta--wrap">No desks match “{query.trim()}”.</span>
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
              <span className="loki-meta loki-meta--wrap">No desks yet.</span>
              {onNew && <Button onClick={() => onNew(null)}>New desk</Button>}
            </div>
          )}
        </div>
        {pills.up && (
          <button type="button" className="loki-sidebar-pill loki-sidebar-pill--up" onClick={() => reveal(pills.up)} aria-label="Scroll up to a desk that needs you">
            <span aria-hidden>↑</span> Needs you
          </button>
        )}
        {pills.down && (
          <button type="button" className="loki-sidebar-pill loki-sidebar-pill--down" onClick={() => reveal(pills.down)} aria-label="Scroll down to a desk that needs you">
            <span aria-hidden>↓</span> Needs you
          </button>
        )}
      </div>
      {menu && <RowMenu {...menu} connected={connected} onClose={() => setMenu(null)} onOpen={onOpen} onPin={onPin} onArchive={onArchive} />}
    </>
  );
}

/** A row's context menu at the pointer: open, pin or unpin, archive or restore, as the desk allows. ↑↓ Enter Esc, or click; a press outside closes it. */
function RowMenu({ desk: d, x, y, connected, onClose, onOpen, onPin, onArchive }: { desk: DeskSummary; x: number; y: number; connected: boolean; onClose: () => void } & Pick<DeskSidebarProps, "onOpen" | "onPin" | "onArchive">) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) closeRef.current();
    };
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, []);
  const archived = d.status === "archived";
  const pick = (fn: () => void) => () => {
    onClose();
    fn();
  };
  // Kept inside the window: a menu opened near the right or bottom edge moves in.
  const left = Math.min(x, (typeof window === "undefined" ? x : window.innerWidth) - 228);
  const top = Math.min(y, (typeof window === "undefined" ? y : window.innerHeight) - 132);
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`${d.title ?? "Desk"} actions`}
      className="loki-sidebar-menu"
      style={{ left: Math.max(8, left), top: Math.max(8, top) }}
      onKeyDown={(e) => {
        const all = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
        const i = all.indexOf(document.activeElement as HTMLElement);
        if (e.key === "ArrowDown") all[Math.min(all.length - 1, i + 1)]?.focus();
        else if (e.key === "ArrowUp") all[Math.max(0, i - 1)]?.focus();
        else if (e.key === "Escape" || e.key === "Tab") onClose();
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <Row dense role="menuitem" onClick={pick(() => onOpen(d.scope))}>
        Open
      </Row>
      {canPin(d) && (
        <Row dense role="menuitem" onClick={pick(() => onPin(d, !d.pinned))}>
          {d.pinned ? "Unpin" : "Pin to the top"}
        </Row>
      )}
      {canArchive(d) && (
        <Row dense role="menuitem" disabled={!connected} title={connected ? undefined : NO_ARCHIVE_REASON} onClick={pick(() => onArchive(d, !archived))}>
          {archived ? "Restore from the archive" : "Archive"}
        </Row>
      )}
    </div>
  );
}

/**
 * The sidebar wired to the window's models, as the tree was (views.tsx SwitcherTree): pin through the mod,
 * archive through the app-server and then a fresh desks list, each with a notice.
 */
export function DeskSidebarView({ desk, catchUp, notice, onOpen, onNew }: { desk: Desk; catchUp: CatchUp; notice: (m: string) => void; onOpen: (scope: string) => void; onNew: (agentId: string | null) => void }) {
  return (
    <DeskSidebar
      desks={desk.desks.list}
      agents={catchUp.agents}
      items={catchUp.items}
      current={desk.scope}
      connected={catchUp.status === "open"}
      avatar={avatarUrl}
      onOpen={onOpen}
      onNew={desk.attention.available ? onNew : undefined}
      onPin={(d, pinned) => {
        if (d.agentId && d.conversationId) desk.desks.pin(d.agentId, d.conversationId, pinned);
      }}
      onArchive={(d, archived) => {
        if (!d.conversationId) return;
        void catchUp.archiveConversation(d.conversationId, archived).then((err) => {
          if (err) return notice(`archive: ${err}`);
          notice(`${d.title ?? d.scope} ${archived ? "archived" : "restored"}`);
          desk.desks.request();
        });
      }}
    />
  );
}
