import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import type { Runtime } from "../../../core/attention/protocol.ts";
import { ago } from "../board/model";
import { AgentFace } from "../desk/AgentChip";
import { avatarUrl } from "../desk/env";
import type { DeskSummary } from "../desk/useDesk";
import { BADGE } from "../desk/CatchUp";
import { agentChips, deskMark } from "../shell/DeskTree";
import { Button, Chip, Field, Sheet } from "../components";
import { Icon, type IconName } from "./icons";
import { homeCounts, homeSections, shortcutLine, type HomeAttention, type HomeCounts, type LinkState, type Shortcut } from "./model";
import type { Me } from "./Pair";
import { navigate, type Route } from "./router";
import { Avatar, PhoneRow, RowIcon, RowSection } from "./rows";
import { Scroll } from "./ui";

/** A desk's conversation, full screen; the shared sheet has none on a phone. */
export function openDesk(d: DeskSummary) {
  if (d.agentId && d.conversationId) navigate({ kind: "conversation", agentId: d.agentId, conversationId: d.conversationId, prefill: null });
}

function openAttention(item: AttentionItem) {
  navigate({ kind: "conversation", agentId: item.agentId, conversationId: item.id, prefill: null });
}

/** Archive or restore a desk's conversation through the app-server; resolves to an error, or null when done. */
export type ArchiveDesk = (d: DeskSummary, archived: boolean) => Promise<string | null>;

/** What the presence dot and its name say about the paired Mac. */
const LINK_WORD: Record<LinkState, string> = { online: "Mac connected", connecting: "connecting to the Mac", offline: "Mac unreachable" };

/**
 * Home, Slack's orientation screen with loki's content: the workspace header (loki, the menu, the
 * profile with the Mac's presence), a rail of shortcuts with their counts, then "Needs your attention"
 * — the head of the Inbox queue — and the live desks, each conversation in one of the two, never both
 * (model.ts homeSections). The filter, the agent scope, refresh and a new desk live in the menu; while a
 * filter is on it shows as a pill that clears it. A long press on a desk (or its actions button) pins or
 * archives it. Home stays mounted under other pages, so all of this — and the scroll — survives a round trip.
 */
export function Home({
  me,
  link,
  desks,
  desksLoaded,
  agents,
  items,
  due,
  hidden = false,
  banner,
  onRefresh,
  onPin,
  onArchive,
  recentFolders,
  onCreate,
}: {
  me: Me;
  link: LinkState;
  desks: DeskSummary[];
  /** The mod has answered with the list: an empty one then means no desks yet. */
  desksLoaded: boolean;
  agents: Array<{ id: string; name: string }>;
  items: AttentionItem[];
  due: number;
  /** Keep Home mounted under child pages so the filter, the folds and the scroll survive the round trip. */
  hidden?: boolean;
  banner?: ReactNode;
  /** Ask the mod for the list again (on mount, from the menu, and when the socket reopens). */
  onRefresh: () => void;
  onPin: (agentId: string, conversationId: string, pinned: boolean) => void;
  /** Null while the app-server cannot take it (not reachable, or not on this Mac). */
  onArchive: ArchiveDesk | null;
  /** `folders_get`: the folders each agent worked in, most recent first. */
  recentFolders: () => Promise<Record<string, string[]>>;
  /** A new conversation through the app-server; resolves to its runtime. */
  onCreate: (agentId: string, folder: string, name: string) => Promise<Runtime>;
}) {
  const [query, setQuery] = useState("");
  const [agentFilter, setAgentFilter] = useState<string | null>(null);
  const [open, setOpen] = useState({ attention: true, desks: true });
  const [sheet, setSheet] = useState<"menu" | "new" | null>(null);
  const [acting, setActing] = useState<DeskSummary | null>(null);

  useEffect(onRefresh, []); // eslint-disable-line react-hooks/exhaustive-deps

  const marks = useMemo(() => {
    const m = new Map<string, AttentionItem>();
    for (const i of items) m.set(`${i.agentId}/${i.id}`, i);
    return m;
  }, [items]);
  const chips = useMemo(() => agentChips(agents, desks), [agents, desks]);
  const counts = useMemo(() => homeCounts({ items, due, agents: chips, desks }), [items, due, chips, desks]);
  const sections = useMemo(() => homeSections(desks, items, agentFilter, query), [desks, items, agentFilter, query]);
  const filtered = !!query.trim() || !!agentFilter;

  return (
    <div className="loki-phone-page" hidden={hidden}>
      <HomeHeader me={me} link={link} filtered={filtered} onMenu={() => setSheet("menu")} />
      {banner}
      <Scroll memory="home" flush>
        <ShortcutRail counts={counts} />
        <FilterPills query={query} agentFilter={agentFilter} agents={chips} onClearQuery={() => setQuery("")} onClearAgent={() => setAgentFilter(null)} />

        <AttentionSection attention={sections.attention} more={sections.more} waiting={counts.inbox} />
        <DeskSection
          shown={sections.desks}
          marks={marks}
          empty={desks.length === 0}
          loaded={desksLoaded}
          nothingMatches={desks.length > 0 && filtered && sections.desks.length === 0 && sections.attention.length === 0}
          filtered={filtered}
          open={open.desks || filtered}
          onToggle={filtered ? undefined : () => setOpen((o) => ({ ...o, desks: !o.desks }))}
          onActions={setActing}
          onNew={() => setSheet("new")}
          onClearFilters={() => (setQuery(""), setAgentFilter(null))}
        />
      </Scroll>

      {sheet === "menu" && (
        <HomeMenu
          query={query}
          onQuery={setQuery}
          agents={chips}
          agentFilter={agentFilter}
          onAgent={setAgentFilter}
          onNew={() => setSheet("new")}
          onRefresh={() => (onRefresh(), setSheet(null))}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "new" && <NewSheet agents={chips} defaultAgentId={agentFilter} recentFolders={recentFolders} onCreate={onCreate} onClose={() => setSheet(null)} />}
      {acting && <ActingDesk desk={acting} onPin={onPin} onArchive={onArchive} onClose={() => setActing(null)} />}
    </div>
  );
}

/** The filters in force, each a pill that clears it; nothing while none is on. */
function FilterPills({ query, agentFilter, agents, onClearQuery, onClearAgent }: { query: string; agentFilter: string | null; agents: Array<{ id: string; name: string | null }>; onClearQuery: () => void; onClearAgent: () => void }) {
  const q = query.trim();
  if (!q && !agentFilter) return null;
  const scopeName = agentFilter ? (agents.find((c) => c.id === agentFilter)?.name ?? "agent") : null;
  return (
    <div className="loki-phone-pills" role="group" aria-label="filters on">
      {q && <FilterPill label={`\u201c${q}\u201d`} onClear={onClearQuery} />}
      {scopeName && <FilterPill label={scopeName} onClear={onClearAgent} />}
    </div>
  );
}

/** A desk's actions sheet from Home: pin only for a live desk with a conversation, archive while the app-server takes it. */
function ActingDesk({ desk, onPin, onArchive, onClose }: { desk: DeskSummary; onPin: (agentId: string, conversationId: string, pinned: boolean) => void; onArchive: ArchiveDesk | null; onClose: () => void }) {
  const { agentId, conversationId } = desk;
  const pin = agentId && conversationId && desk.status === "live" ? (p: boolean) => onPin(agentId, conversationId, p) : null;
  return <DeskActions desk={desk} onClose={onClose} onPin={pin} onArchive={onArchive ? (archived) => onArchive(desk, archived) : null} />;
}

/** "Needs your attention": the first of the ready queue, then "n more in Inbox"; absent when nothing waits. */
function AttentionSection({ attention, more, waiting }: { attention: HomeAttention[]; more: number; waiting: number }) {
  if (attention.length === 0) return null;
  return (
    <RowSection icon="inbox" title="Needs your attention" count={waiting} onTitle={() => navigate({ kind: "tab", tab: "inbox" })} titleLabel={`Needs your attention, ${waiting} waiting. Open Inbox`}>
      <ul className="loki-phone-list" aria-label="needs your attention">
        {attention.map((a) => (
          <AttentionRow key={`${a.item.agentId}/${a.item.id}`} entry={a} />
        ))}
        {more > 0 && (
          <li>
            <button type="button" className="loki-phone-row loki-phone-row--quiet" data-launch="home:inbox-more" onClick={() => navigate({ kind: "tab", tab: "inbox" })}>
              <RowIcon name="inbox" />
              <span className="loki-phone-row-copy loki-phone-link">{more} more in Inbox</span>
            </button>
          </li>
        )}
      </ul>
    </RowSection>
  );
}

/** "Desks": the live desks not already above, New desk at the end, and what to say when there are none (yet) or none match. */
function DeskSection({ shown, marks, empty, loaded, nothingMatches, filtered, open, onToggle, onActions, onNew, onClearFilters }: { shown: DeskSummary[]; marks: Map<string, AttentionItem>; empty: boolean; loaded: boolean; nothingMatches: boolean; filtered: boolean; open: boolean; onToggle?: () => void; onActions: (d: DeskSummary) => void; onNew: () => void; onClearFilters: () => void }) {
  return (
    <RowSection icon="desk" title={filtered ? "Matching desks" : "Desks"} open={open} onToggle={onToggle}>
      <ul className="loki-phone-list" aria-label="desks">
        {shown.map((d) => (
          <DeskRow key={d.scope} desk={d} mark={marks.get(`${d.agentId}/${d.conversationId}`)} onActions={() => onActions(d)} />
        ))}
        {!filtered && (
          <li>
            <button type="button" className="loki-phone-row loki-phone-row--quiet" onClick={onNew}>
              <RowIcon name="plus" />
              <span className="loki-phone-row-copy">New desk</span>
            </button>
          </li>
        )}
      </ul>
      {empty && <p className="loki-phone-empty">{loaded ? "No desks yet. New desk starts one: an agent in a folder." : "Reading the desks…"}</p>}
      {nothingMatches && (
        <div className="loki-phone-empty">
          <p>No desks match.</p>
          <Button size="touch" tone="paper" onClick={onClearFilters}>
            Clear filters
          </Button>
        </div>
      )}
    </RowSection>
  );
}

/** loki's mark, the name as the large title, and on the right the menu and the profile with the Mac's presence. */
function HomeHeader({ me, link, filtered, onMenu }: { me: Me; link: LinkState; filtered: boolean; onMenu: () => void }) {
  return (
    <header className="loki-phone-topbar loki-phone-home-top">
      <div className="loki-phone-home-bar">
        <span aria-hidden className="loki-phone-workspace">
          L
        </span>
        <h1 className="loki-phone-large-title loki-phone-home-title" data-phone-heading tabIndex={-1}>
          loki
        </h1>
        <div className="loki-phone-home-actions">
          <button type="button" className="loki-phone-icon-btn loki-phone-home-menu" aria-label={filtered ? "Home menu, filters on" : "Home menu"} aria-haspopup="dialog" data-on={filtered || undefined} onClick={onMenu}>
            <Icon name="menu" size={22} />
          </button>
          <button type="button" className="loki-phone-profile" aria-label={`More, ${me.name}, ${LINK_WORD[link]}`} data-launch="home:profile" onClick={() => navigate({ kind: "tab", tab: "more" })}>
            <span aria-hidden className="loki-phone-profile-face">
              {(me.name || "?").slice(0, 1).toUpperCase()}
            </span>
            <span aria-hidden className="loki-phone-presence" data-link={link} data-on={link === "online"} />
          </button>
        </div>
      </div>
    </header>
  );
}

const SHORTCUTS: Array<{ kind: Shortcut; label: string; icon: IconName; to: Route }> = [
  { kind: "inbox", label: "Inbox", icon: "inbox", to: { kind: "tab", tab: "inbox" } },
  { kind: "learn", label: "Learn", icon: "learn", to: { kind: "learn" } },
  { kind: "agents", label: "Agents", icon: "agents", to: { kind: "tab", tab: "agents" } },
  { kind: "archive", label: "Archive", icon: "archive", to: { kind: "archive" } },
];

/** The rail: one tile per shortcut, scrolling sideways, a red dot on the icon when there is something to do there. */
function ShortcutRail({ counts }: { counts: HomeCounts }) {
  return (
    <nav className="loki-phone-rail" aria-label="shortcuts">
      {SHORTCUTS.map((s) => {
        const line = shortcutLine(s.kind, counts);
        const lit = (s.kind === "inbox" && counts.inbox > 0) || (s.kind === "learn" && counts.learn > 0);
        return (
          <button key={s.kind} type="button" className="loki-phone-tile" data-lit={lit || undefined} data-launch={`home:${s.kind}`} aria-label={`${s.label}, ${line}`} onClick={() => navigate(s.to)}>
            <span className="loki-phone-tile-icon">
              <Icon name={s.icon} size={22} />
              {lit && <span aria-hidden className="loki-phone-tile-dot" />}
            </span>
            <span className="loki-phone-tile-label">{s.label}</span>
            <span className="loki-phone-tile-line">{line}</span>
          </button>
        );
      })}
    </nav>
  );
}

/** An active filter, said out loud, with the × that clears it. */
function FilterPill({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <button type="button" className="loki-phone-pill" aria-label={`Clear filter ${label}`} onClick={onClear}>
      <span className="loki-phone-pill-face">
        <span className="loki-phone-ellipsis">{label}</span>
        <Icon name="close" size={14} />
      </span>
    </button>
  );
}

/** The first words of the agent's last reply, on one line. */
const snippet = (text: string | null | undefined) => (text ? text.replace(/\s+/g, " ").trim().slice(0, 160) : null);

/** A waiting conversation: the agent's face, the desk's name (else the item's), agent · what it waits on, the time, a dot when unread. */
function AttentionRow({ entry: { item, desk } }: { entry: HomeAttention }) {
  const title = desk?.title ?? item.title ?? "new desk";
  const word = BADGE[item.status].label;
  return (
    <PhoneRow
      lead={<Avatar name={item.agentName} src={avatarUrl(item.agentId)} />}
      title={title}
      preview={`${item.agentName ?? "agent"} · ${word}`}
      time={ago(item.lastMessageAt)}
      badge={item.unread || item.status === "approval" || item.status === "question"}
      unread
      label={`${title}, ${item.agentName ?? "agent"}, ${word}`}
      launch={`attention:${item.agentId}/${item.id}`}
      onOpen={() => openAttention(item)}
    />
  );
}

/** What a desk row is called: its title, or "new desk" while it is live and untitled, or its scope once archived. */
export function deskName(d: DeskSummary): string {
  return d.title ?? (d.status === "live" ? "new desk" : d.scope);
}

/**
 * One desk: the #, its name (bold while something in it is new), agent · the last reply or what it is
 * doing, the time or a dot. The same row draws an archived desk, quieter. `onActions` opens DeskActions.
 */
export function DeskRow({ desk: d, mark, onActions }: { desk: DeskSummary; mark: AttentionItem | undefined; onActions: (() => void) | null }) {
  const m = deskMark(mark, d.status);
  const fresh = m.kind === "waits" || m.kind === "finished" || m.kind === "failed";
  const doing = m.kind === "running" ? "running…" : m.kind === "waits" || m.kind === "failed" ? BADGE[mark!.status].label : null;
  const said = doing ?? snippet(mark?.lastAssistantText) ?? (d.status !== "live" ? d.status : null);
  const name = deskName(d);
  return (
    <PhoneRow
      lead={<RowIcon name={d.status === "live" ? "desk" : "archive"} />}
      title={name}
      flags={d.pinned ? <Icon name="pin" size={14} title="pinned" className="loki-phone-row-flag" /> : null}
      preview={said ? `${d.agentName ?? "agent"} · ${said}` : (d.agentName ?? "agent")}
      time={ago(d.lastActive)}
      badge={fresh}
      unread={fresh}
      dim={d.status !== "live"}
      label={`${name}, ${d.agentName ?? "agent"}${d.pinned ? ", pinned" : ""}${m.title ? `, ${m.title}` : ""}`}
      launch={`desk:${d.scope}`}
      onOpen={() => openDesk(d)}
      onActions={onActions}
      actionsLabel={`Actions for ${name}`}
    />
  );
}

/** A main chat cannot be archived, nor a deleted conversation (DeskTree's canArchiveDesk). */
const canArchive = (d: DeskSummary) => !!d.conversationId && d.conversationId !== "default" && d.status !== "deleted";

/**
 * A desk's actions, as a bottom sheet: open it, pin or unpin (live desks), archive or restore. Archive
 * waits for the app-server and stays open with its error when it fails; `onArchive` null means the
 * app-server cannot take it now, and the row says so instead of vanishing.
 */
export function DeskActions({ desk: d, onClose, onPin, onArchive }: { desk: DeskSummary; onClose: () => void; onPin: ((pinned: boolean) => void) | null; onArchive: ((archived: boolean) => Promise<string | null>) | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const archived = d.status === "archived";
  const archive = async () => {
    if (!onArchive) return;
    setBusy(true);
    setError(null);
    const err = await onArchive(!archived);
    if (err) {
      setError(err);
      setBusy(false);
    } else onClose();
  };
  return (
    <Sheet label={`${deskName(d)} actions`} onClose={onClose} placement="bottom" className="loki-phone-sheet">
      <div className="loki-phone-sheet-head">
        <AgentFace name={d.agentName} src={d.agentId ? avatarUrl(d.agentId) : null} size={36} />
        <div className="loki-phone-sheet-copy">
          <div className="loki-phone-title loki-phone-ellipsis">{deskName(d)}</div>
          <div className="loki-phone-meta loki-phone-ellipsis">{d.agentName ?? "agent"}{d.status !== "live" ? ` · ${d.status}` : ""}</div>
        </div>
      </div>
      <ul className="loki-phone-list">
        <SheetRow icon="chevron-right" label="Open desk" onClick={() => (onClose(), openDesk(d))} />
        {onPin && <SheetRow icon="pin" label={d.pinned ? "Unpin" : "Pin to the top"} onClick={() => (onPin(!d.pinned), onClose())} />}
        {canArchive(d) && <SheetRow icon="archive" label={busy ? (archived ? "Restoring…" : "Archiving…") : archived ? "Restore to Desks" : "Archive"} aside={onArchive ? null : "Not connected"} disabled={!onArchive || busy} onClick={() => void archive()} />}
      </ul>
      {error && (
        <p role="alert" className="loki-phone-error">
          {error}
        </p>
      )}
      <Button size="touch" tone="paper" block onClick={onClose}>
        Cancel
      </Button>
    </Sheet>
  );
}

/** One row of a sheet's list, the More row's shape without the chevron (the conversation's actions sheet uses it too). */
export function SheetRow({ icon, label, aside = null, disabled = false, onClick }: { icon: IconName; label: string; aside?: string | null; disabled?: boolean; onClick: () => void }) {
  return (
    <li>
      <button type="button" className="loki-phone-menu-row" disabled={disabled} onClick={onClick}>
        <Icon name={icon} size={22} />
        <span className="loki-phone-menu-row-label">{label}</span>
        {aside && <span className="loki-phone-menu-row-aside">{aside}</span>}
      </button>
    </li>
  );
}

/**
 * Home's menu: the filter and the agent scope that used to sit over the list, then a new desk and a
 * refresh. The filter applies as you type, so closing the sheet shows the narrowed list at once.
 */
function HomeMenu({ query, onQuery, agents, agentFilter, onAgent, onNew, onRefresh, onClose }: { query: string; onQuery: (q: string) => void; agents: Array<{ id: string; name: string | null; count: number }>; agentFilter: string | null; onAgent: (id: string | null) => void; onNew: () => void; onRefresh: () => void; onClose: () => void }) {
  return (
    <Sheet label="Home menu" onClose={onClose} placement="bottom" className="loki-phone-sheet">
      <Field
        type="search"
        size="touch"
        name="desk-filter"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder="Filter desks"
        aria-label="Filter desks"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        enterKeyHint="done"
        onKeyDown={(e) => e.key === "Enter" && onClose()}
        data-1p-ignore
        data-form-type="other"
      />
      <div role="group" aria-label="Agent" className="loki-phone-chips">
        <Chip touch active={agentFilter === null} aria-pressed={agentFilter === null} onClick={() => onAgent(null)}>
          All agents
        </Chip>
        {agents.map((c) => (
          <Chip key={c.id} touch active={agentFilter === c.id} aria-pressed={agentFilter === c.id} onClick={() => onAgent(agentFilter === c.id ? null : c.id)}>
            <AgentFace name={c.name} src={avatarUrl(c.id)} size={18} />
            {c.name ?? "agent"} <span className="loki-phone-chip-count">{c.count}</span>
          </Chip>
        ))}
      </div>
      <ul className="loki-phone-list">
        <SheetRow icon="plus" label="New desk" onClick={onNew} />
        <SheetRow icon="refresh" label="Refresh desks" onClick={onRefresh} />
        <SheetRow icon="archive" label="Archived desks" onClick={() => (onClose(), navigate({ kind: "archive" }))} />
      </ul>
      <Button size="touch" tone="paper" block onClick={onClose}>
        Done
      </Button>
    </Sheet>
  );
}

/** The agent's most recent folder on the Mac, once the list has arrived; null before, and when it has none. */
function folderFor(recent: Record<string, string[]> | null, agentId: string | null): string | null {
  return agentId && recent ? recent[agentId]?.[0] ?? null : null;
}

/** `folders_get`, once: the folders each agent worked in, most recent first; null until the Mac answers. */
function useRecentFolders(recentFolders: () => Promise<Record<string, string[]>>) {
  const [recent, setRecent] = useState<Record<string, string[]> | null>(null);
  useEffect(() => {
    let live = true;
    void recentFolders().then((r) => live && setRecent(r));
    return () => {
      live = false;
    };
  }, [recentFolders]);
  return recent;
}

/**
 * The sheet's draft: the agent picked, the optional name, the folder that follows the agent, the busy
 * flag and the error from the last try. `start` creates the conversation, closes the sheet and opens it.
 */
function useNewDesk(agents: Array<{ id: string; name: string | null }>, defaultAgentId: string | null, recentFolders: () => Promise<Record<string, string[]>>, onCreate: (agentId: string, folder: string, name: string) => Promise<Runtime>, onClose: () => void) {
  const [agentId, setAgentId] = useState<string | null>(defaultAgentId ?? agents[0]?.id ?? null);
  const [name, setName] = useState("");
  const recent = useRecentFolders(recentFolders);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agentName = agents.find((a) => a.id === agentId)?.name ?? null;
  const folder = folderFor(recent, agentId);
  const canStart = !!agentId && !!folder && !busy;
  const start = async () => {
    if (!canStart || !agentId || !folder) return;
    setBusy(true);
    setError(null);
    try {
      const rt = await onCreate(agentId, folder, name.trim());
      onClose();
      navigate({ kind: "conversation", agentId: rt.agent_id, conversationId: rt.conversation_id, prefill: null });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  return { agentId, setAgentId, name, setName, recent, agentName, folder, busy, error, canStart, start };
}

/**
 * The plus: pick an agent, name it if you like, start. The folder is the agent's most recent one on
 * the Mac; when it has none, the sheet says so and start stays off — choosing a folder is the Mac's job.
 */
function NewSheet({ agents, defaultAgentId, recentFolders, onCreate, onClose }: { agents: Array<{ id: string; name: string | null }>; defaultAgentId: string | null; recentFolders: () => Promise<Record<string, string[]>>; onCreate: (agentId: string, folder: string, name: string) => Promise<Runtime>; onClose: () => void }) {
  const { agentId, setAgentId, name, setName, recent, agentName, folder, busy, error, canStart, start } = useNewDesk(agents, defaultAgentId, recentFolders, onCreate, onClose);
  return (
    <Sheet label="New desk" onClose={onClose} placement="bottom" className="loki-phone-sheet">
      <div className="loki-phone-sheet-copy">
        <div className="loki-phone-meta">New desk</div>
        <div className="loki-phone-title">{agentName ? `With ${agentName}` : "With an agent"}</div>
      </div>
      <AgentPicker agents={agents} agentId={agentId} onPick={setAgentId} />
      <Field size="touch" name="conversation-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" aria-label="Desk name" autoComplete="off" data-1p-ignore data-form-type="other" enterKeyHint="go" onKeyDown={(e) => e.key === "Enter" && void start()} />
      <FolderLine recent={recent} folder={folder} agentName={agentName} />
      {error && (
        <p role="alert" className="loki-phone-error">
          {error}
        </p>
      )}
      <div className="loki-phone-sheet-actions">
        <Button size="touch" tone="paper" onClick={onClose}>
          Cancel
        </Button>
        <Button size="touch" tone="brass" onClick={() => void start()} disabled={!canStart}>
          {busy ? "Starting…" : "Start"}
        </Button>
      </div>
    </Sheet>
  );
}

/** The agent chips, one lit; a line instead when the harness has no agents yet. */
function AgentPicker({ agents, agentId, onPick }: { agents: Array<{ id: string; name: string | null }>; agentId: string | null; onPick: (id: string) => void }) {
  return (
    <div role="radiogroup" aria-label="Agent" className="loki-phone-chips loki-phone-chips--wrap">
      {agents.map((a) => (
        <Chip key={a.id} touch role="radio" active={a.id === agentId} aria-checked={a.id === agentId} onClick={() => onPick(a.id)}>
          <AgentFace name={a.name} src={avatarUrl(a.id)} size={18} />
          {a.name ?? "agent"}
        </Chip>
      ))}
      {agents.length === 0 && <span className="loki-phone-meta">No agents yet. Is Letta Code running on the Mac?</span>}
    </div>
  );
}

/** Where the desk will start: waiting on the Mac, the folder (home shortened to ~), or why there is none. */
function FolderLine({ recent, folder, agentName }: { recent: Record<string, string[]> | null; folder: string | null; agentName: string | null }) {
  const short = folder ? folder.replace(/^\/Users\/[^/]+/, "~") : null;
  return (
    <p className={folder || recent === null ? "loki-phone-meta loki-phone-wrap" : "loki-phone-error"}>
      {recent === null ? "Asking the Mac for folders…" : folder ? `In ${short}` : `${agentName ?? "This agent"} has no recent folder on the Mac; start its first desk there.`}
    </p>
  );
}
