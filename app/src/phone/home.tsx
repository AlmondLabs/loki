import { useEffect, useEffectEvent, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { labelQuery, toggleLabelTerm, type LabelView } from "../../../core/labels.ts";
import { labelColor } from "../chat/labels";
import type { AttentionItem } from "../../../core/attention/model.ts";
import type { Runtime } from "../../../core/attention/protocol.ts";
import { ago } from "../shared/ago";
import { AgentFace } from "../desk/agent-chip";
import type { Homes } from "../shell/desk-sidebar";
import { HomeMark } from "../shell/home-mark";
import { deskRowState } from "../shell/sidebar-model";
import { avatarUrl } from "../desk/env";

import { BADGE } from "../desk/catch-up";
import { agentChips } from "../shell/desk-tree";
import type { SidebarSection } from "../shell/sidebar-model";
import { Button, Chip, Field, Sheet } from "../components";
import { Icon, type IconName } from "./icons";
import { deskName, homeLists, shortcutLine, type HomeAttention, type HomeCounts, type LinkState, type Shortcut } from "./model";
import type { Me } from "./pair";
import { navigate, openConversation, type Route } from "./router";
import { PhoneRow, RowIcon, RowSection, SkeletonRows } from "./rows";
import { Scroll, useTopClearance } from "./ui";
import { RenameSheet } from "./rename-sheet";
import { chosenFolder, folderName, foldersOf, shownFolders } from "./new-chat-folders";
import { canRename } from "../shell/sidebar-model";
import type { DeskSummary } from "../../../core/frame-types.ts";
import { messageOf } from "../../../core/errors.ts";
import { isMainChat } from "../../../core/desk-core.ts";

export function openDesk(d: DeskSummary) {
  if (d.agent_id && d.conversation_id) openConversation(d.agent_id, d.conversation_id);
}

export type ArchiveDesk = (d: DeskSummary, archived: boolean) => Promise<string | null>;
export type RenameDeskName = (d: DeskSummary, name: string) => Promise<string | null>;
export type SetDeskPurpose = (d: DeskSummary, purpose: string) => Promise<string | null>;

const LINK_WORD: Record<LinkState, string> = { online: "Mac connected", connecting: "connecting to the Mac", offline: "Mac unreachable" };

export function Home({
  me,
  link,
  desks,
  desksLoaded,
  agents,
  items,
  laneItems = items,
  due,
  hidden = false,
  banner,
  onRefresh,
  onPin,
  onArchive,
  onRename,
  onPurpose = null,
  recentFolders,
  onCreate,
  homes,
  labelList = null,
  onTopCard,
}: {
  me: Me;
  link: LinkState;
  desks: DeskSummary[];
  desksLoaded: boolean;
  agents: Array<{ id: string; name: string }>;
  items: AttentionItem[];
  laneItems?: AttentionItem[];
  due: number;
  hidden?: boolean;
  banner?: ReactNode;
  onRefresh: () => void;
  homes?: Homes;
  labelList?: LabelView[] | null;
  onPin: (agentId: string, conversationId: string, pinned: boolean) => void;
  onArchive: ArchiveDesk | null;
  onRename: RenameDeskName | null;
  onPurpose?: SetDeskPurpose | null;
  recentFolders: () => Promise<Partial<Record<string, string[]>>>;
  onCreate: (agentId: string, folder: string, name: string) => Promise<Runtime>;
  onTopCard: (item: AttentionItem) => void;
}) {
  const [query, setQuery] = useState("");
  const [folded, setFolded] = useState<string[]>(loadFolds);
  const toggleFold = (id: string) => {
    const next = folded.includes(id) ? folded.filter((x) => x !== id) : [...folded, id];
    setFolded(next);
    saveFolds(next);
  };
  const [sheet, setSheet] = useState<"menu" | "new" | null>(null);
  const [acting, setActing] = useState<DeskSummary | null>(null);

  const refresh = useEffectEvent(onRefresh);
  useEffect(() => refresh(), []);

  const marks = useMemo(() => {
    const m = new Map<string, AttentionItem>();
    for (const i of items) m.set(`${i.agent_id}/${i.id}`, i);
    return m;
  }, [items]);
  const chips = useMemo(() => agentChips(agents, desks), [agents, desks]);
  const { counts, attention, more, groups } = useMemo(
    () => homeLists({ desks, items, laneItems, query, agents: chips, due }),
    [desks, items, laneItems, query, chips, due],
  );
  const filtered = !!query.trim();

  return (
    <div className="loki-phone-page" hidden={hidden}>
      <HomeHeader me={me} link={link} filtered={filtered} onMenu={() => setSheet("menu")} banner={banner} />
      <Scroll memory="home" flush flip={filtered ? undefined : homeOrder(attention, more, groups, folded)}>
        <ShortcutRail counts={counts} />
        <FilterPills query={query} labelList={labelList} onQuery={setQuery} />

        <AttentionSection attention={attention} more={more} waiting={counts.inbox} onTopCard={onTopCard} />
        <DeskSections
          groups={groups}
          marks={marks}
          homes={homes}
          folded={folded}
          onToggle={toggleFold}
          empty={desks.length === 0}
          loaded={desksLoaded}
          nothingMatches={desks.length > 0 && filtered && groups.length === 0 && attention.length === 0}
          filtered={filtered}
          onActions={setActing}
          onNew={() => setSheet("new")}
          onClearFilters={() => setQuery("")}
        />
      </Scroll>
      <button type="button" className="loki-phone-compose" aria-label="New chat" onClick={() => setSheet("new")}>
        <Icon name="compose" size={24} />
      </button>

      {sheet === "menu" && (
        <HomeMenu query={query} labelList={labelList} onQuery={setQuery} onRefresh={() => (onRefresh(), setSheet(null))} onClose={() => setSheet(null)} />
      )}
      {sheet === "new" && <NewSheet agents={chips} defaultAgentId={null} recentFolders={recentFolders} onCreate={onCreate} onClose={() => setSheet(null)} />}
      {acting && <ActingDesk desk={acting} onPin={onPin} onArchive={onArchive} onRename={onRename} onPurpose={onPurpose} onClose={() => setActing(null)} />}
    </div>
  );
}

const homeOrder = (attention: HomeAttention[], more: number, groups: SidebarSection[], folded: string[]): string =>
  `${attention.map((a) => `${a.item.agent_id}/${a.item.id}`).join(",")}|${more > 0}|${groups.map((g) => (folded.includes(g.id) ? `${g.id}:-` : `${g.id}:${g.rows.map((r) => r.desk.scope).join(",")}`)).join(";")}`;

const FOLDS_KEY = "loki.phone.home.folded.v1";
function loadFolds(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(FOLDS_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function saveFolds(folded: string[]): void {
  try {
    localStorage.setItem(FOLDS_KEY, JSON.stringify(folded));
  } catch {}
}

function FilterPills({ query, labelList, onQuery }: { query: string; labelList: LabelView[] | null; onQuery: (q: string) => void }) {
  const { labels, text } = labelQuery(query);
  if (!labels.length && !text) return null;
  return (
    <div className="loki-phone-pills" role="group" aria-label="Filters on">
      {labels.map((l) => (
        <FilterPill key={l} label={l} tone={labelColor(l, labelList)} onClear={() => onQuery(toggleLabelTerm(query, l))} />
      ))}
      {text && <FilterPill label={`\u201c${text}\u201d`} onClear={() => onQuery(labels.map((l) => `label:${l}`).join(" "))} />}
    </div>
  );
}

function ActingDesk({
  desk,
  onPin,
  onArchive,
  onRename,
  onPurpose,
  onClose,
}: {
  desk: DeskSummary;
  onPin: (agentId: string, conversationId: string, pinned: boolean) => void;
  onArchive: ArchiveDesk | null;
  onRename: RenameDeskName | null;
  onPurpose: SetDeskPurpose | null;
  onClose: () => void;
}) {
  const { agent_id: agentId, conversation_id: conversationId } = desk;
  const pin = agentId && conversationId && desk.status === "live" ? (p: boolean) => onPin(agentId, conversationId, p) : null;
  return (
    <DeskActions
      desk={desk}
      onClose={onClose}
      onPin={pin}
      onArchive={onArchive ? (archived) => onArchive(desk, archived) : null}
      onRename={onRename ? (name) => onRename(desk, name) : null}
      onPurpose={onPurpose ? (purpose) => onPurpose(desk, purpose) : null}
    />
  );
}

function AttentionSection({
  attention,
  more,
  waiting,
  onTopCard,
}: {
  attention: HomeAttention[];
  more: number;
  waiting: number;
  onTopCard: (item: AttentionItem) => void;
}) {
  if (attention.length === 0) return null;
  return (
    <RowSection
      icon="inbox"
      title="Needs your attention"
      count={waiting}
      onTitle={() => navigate({ kind: "tab", tab: "inbox" })}
      titleLabel={`Needs your attention, ${waiting} waiting. Open Flow`}
    >
      <ul className="loki-phone-list" aria-label="Needs your attention">
        {attention.map((a) => (
          <AttentionRow key={`${a.item.agent_id}/${a.item.id}`} entry={a} onTopCard={onTopCard} />
        ))}
        {more > 0 && (
          <li data-flip="inbox-more">
            <button
              type="button"
              className="loki-phone-row loki-phone-row--quiet"
              data-launch="home:inbox-more"
              onClick={() => navigate({ kind: "tab", tab: "inbox" })}
            >
              <span className="loki-phone-row-copy loki-phone-link">{more} more in Flow</span>
            </button>
          </li>
        )}
      </ul>
    </RowSection>
  );
}

function DeskSections({
  groups,
  marks,
  homes,
  folded,
  onToggle,
  empty,
  loaded,
  nothingMatches,
  filtered,
  onActions,
  onNew,
  onClearFilters,
}: {
  groups: SidebarSection[];
  marks: Map<string, AttentionItem>;
  homes?: Homes;
  folded: string[];
  onToggle: (id: string) => void;
  empty: boolean;
  loaded: boolean;
  nothingMatches: boolean;
  filtered: boolean;
  onActions: (d: DeskSummary) => void;
  onNew: () => void;
  onClearFilters: () => void;
}) {
  return (
    <>
      {groups.map((g) => {
        const pinned = g.id === "pinned";
        return (
          <RowSection
            key={g.id}
            icon={pinned ? "pin" : "desk"}
            lead={pinned ? undefined : <AgentFace name={g.title} src={g.agentId ? avatarUrl(g.agentId) : null} size={20} />}
            title={g.title}
            aside={g.agentId ? homes?.of(g.agentId)?.name : undefined}
            count={g.waiting}
            open={filtered || !folded.includes(g.id)}
            onToggle={filtered ? undefined : () => onToggle(g.id)}
          >
            <ul className="loki-phone-list" aria-label={pinned ? "Pinned chats" : `${g.title}'s chats`}>
              {g.rows.map((r) => (
                <DeskRow
                  key={r.desk.scope}
                  desk={r.desk}
                  mark={marks.get(`${r.desk.agent_id}/${r.desk.conversation_id}`)}
                  onActions={() => onActions(r.desk)}
                  homes={homes}
                  inPinned={pinned}
                />
              ))}
            </ul>
          </RowSection>
        );
      })}
      {!filtered && (
        <ul className="loki-phone-list" aria-label="New chat">
          <li data-flip="new-desk">
            <button type="button" className="loki-phone-row loki-phone-row--quiet" onClick={onNew}>
              <RowIcon name="plus" />
              <span className="loki-phone-row-copy">New chat</span>
            </button>
          </li>
        </ul>
      )}
      {empty &&
        (loaded ? <p className="loki-phone-empty">No chats yet. New chat starts one: an agent in a folder.</p> : <SkeletonRows label="Reading the chats…" />)}
      {nothingMatches && (
        <div className="loki-phone-empty">
          <p>No chats match.</p>
          <Button size="touch" tone="paper" onClick={onClearFilters}>
            Clear Filter
          </Button>
        </div>
      )}
    </>
  );
}

function HomeHeader({ me, link, filtered, onMenu, banner }: { me: Me; link: LinkState; filtered: boolean; onMenu: () => void; banner?: ReactNode }) {
  const top = useTopClearance<HTMLElement>();
  return (
    <header ref={top} className="loki-phone-topbar loki-phone-home-top">
      <div className="loki-phone-home-bar">
        <img src="/mark.png" alt="" aria-hidden className="loki-phone-workspace" width={44} height={44} />
        <h1 className="loki-phone-large-title loki-phone-home-title" data-phone-heading tabIndex={-1}>
          loki
        </h1>
        <div className="loki-phone-home-actions">
          <button
            type="button"
            className="loki-phone-icon-btn loki-phone-home-menu"
            aria-label={filtered ? "Home menu, filters on" : "Home menu"}
            aria-haspopup="dialog"
            data-on={filtered || undefined}
            onClick={onMenu}
          >
            <Icon name="menu" size={22} />
          </button>
          <button
            type="button"
            className="loki-phone-profile"
            aria-label={`More, ${me.name}, ${LINK_WORD[link]}`}
            data-launch="home:profile"
            onClick={() => navigate({ kind: "tab", tab: "more" })}
          >
            <span aria-hidden className="loki-phone-profile-face">
              {(me.name || "?").slice(0, 1).toUpperCase()}
            </span>
            <span aria-hidden className="loki-phone-presence" data-link={link} data-on={link === "online"} />
          </button>
        </div>
      </div>
      {banner}
    </header>
  );
}

const SHORTCUTS: Array<{ kind: Shortcut; label: string; icon: IconName; to: Route }> = [
  { kind: "inbox", label: "Flow", icon: "inbox", to: { kind: "tab", tab: "inbox" } },
  { kind: "learn", label: "Learn", icon: "learn", to: { kind: "learn" } },
  { kind: "agents", label: "Agents", icon: "agents", to: { kind: "tab", tab: "agents" } },
  { kind: "archive", label: "Archive", icon: "archive", to: { kind: "archive" } },
];

function ShortcutRail({ counts }: { counts: HomeCounts }) {
  return (
    <nav className="loki-phone-rail" aria-label="Shortcuts">
      {SHORTCUTS.map((s) => {
        const line = shortcutLine(s.kind, counts);
        const lit = (s.kind === "inbox" && counts.inbox > 0) || (s.kind === "learn" && counts.learn > 0);
        return (
          <button
            key={s.kind}
            type="button"
            className="loki-phone-tile"
            data-lit={lit || undefined}
            data-launch={`home:${s.kind}`}
            aria-label={`${s.label}, ${line}`}
            onClick={() => navigate(s.to)}
          >
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

function FilterPill({ label, tone, onClear }: { label: string; tone?: string; onClear: () => void }) {
  return (
    <button type="button" className="loki-phone-pill" aria-label={`Clear Filter ${label}`} onClick={onClear}>
      <span className="loki-phone-pill-face">
        {tone && <span aria-hidden className="loki-label-dot" style={{ "--label-tone": tone } as CSSProperties} />}
        <span className="loki-phone-ellipsis">{label}</span>
        <Icon name="close" size={14} />
      </span>
    </button>
  );
}

function AttentionRow({ entry: { item, desk, opens }, onTopCard }: { entry: HomeAttention; onTopCard: (item: AttentionItem) => void }) {
  const title = desk?.title ?? item.title ?? "New chat";
  const word = BADGE[item.status].label;
  const row = deskRowState(item, desk ?? { status: "live" });
  return (
    <PhoneRow
      title={title}
      flags={<span className="loki-phone-row-agent">· {item.agent_name ?? "agent"}</span>}
      time={ago(item.last_message_at)}
      badge={row.badge}
      live={row.live}
      unread={row.unread}
      label={`${title}, ${item.agent_name ?? "agent"}, ${word}`}
      launch={`attention:${item.agent_id}/${item.id}`}
      flip={`conv:${item.agent_id}/${item.id}`}
      onOpen={() => {
        if (opens === "chat") openConversation(item.agent_id, item.id);
        else {
          onTopCard(item);
          navigate({ kind: "tab", tab: "inbox" });
        }
      }}
    />
  );
}

export function DeskRow({
  desk: d,
  mark,
  onActions,
  homes,
  inPinned = false,
}: {
  desk: DeskSummary;
  mark: AttentionItem | undefined;
  onActions: (() => void) | null;
  homes?: Homes;
  inPinned?: boolean;
}) {
  const row = deskRowState(mark, d);
  const name = deskName(d);
  const agentHome = d.agent_id ? homes?.of(d.agent_id)?.mac : null;
  return (
    <PhoneRow
      title={name}
      flags={
        <>
          {d.pinned && !inPinned && <Icon name="pin" size={14} title="Pinned" className="loki-phone-row-flag" />}
          <HomeMark row={d} agentHome={agentHome} here={homes?.here} />
        </>
      }
      time={ago(d.last_active)}
      badge={row.badge}
      live={row.live}
      unread={row.unread}
      dim={d.status !== "live" || d.reachable === false}
      label={`${name}, ${d.agent_name ?? "agent"}${d.pinned ? ", pinned" : ""}${row.badgeNoun ? `, ${row.badgeNoun}` : row.note ? `, ${row.note}` : ""}`}
      launch={`desk:${d.scope}`}
      flip={d.conversation_id ? `conv:${d.agent_id}/${d.conversation_id}` : undefined}
      onOpen={() => openDesk(d)}
      onActions={onActions}
      actionsLabel={`Actions for ${name}`}
    />
  );
}

const canArchive = (d: DeskSummary) => !!d.conversation_id && !isMainChat(d.conversation_id) && d.status !== "deleted";

export function DeskActions({
  desk: d,
  onClose,
  onPin,
  onArchive,
  onRename,
  onPurpose = null,
}: {
  desk: DeskSummary;
  onClose: () => void;
  onPin: ((pinned: boolean) => void) | null;
  onArchive: ((archived: boolean) => Promise<string | null>) | null;
  onRename: ((name: string) => Promise<string | null>) | null;
  onPurpose?: ((purpose: string) => Promise<string | null>) | null;
}) {
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const archived = d.status === "archived";
  const archive = async () => {
    if (!onArchive) return;
    setBusy(true);
    setError(null);
    let err: string | null;
    try {
      err = await onArchive(!archived);
    } catch (e) {
      err = messageOf(e);
    }
    // Outside (React Compiler): it cannot compile a finally; the catch cannot throw, so this runs after either branch.
    setBusy(false);
    if (err) setError(err);
    else onClose();
  };
  if (renaming && onRename)
    return <RenameSheet name={d.title ?? ""} onRename={onRename} onClose={onClose} purpose={d.purpose} onPurpose={onPurpose ?? undefined} />;
  return (
    <Sheet label={`${deskName(d)} actions`} onClose={onClose} placement="bottom" className="loki-phone-sheet">
      <div className="loki-phone-sheet-head">
        <AgentFace name={d.agent_name} src={d.agent_id ? avatarUrl(d.agent_id) : null} size={36} />
        <div className="loki-phone-sheet-copy">
          <div className="loki-phone-title loki-phone-ellipsis">{deskName(d)}</div>
          <div className="loki-phone-meta loki-phone-ellipsis">
            {d.agent_name ?? "agent"}
            {d.status !== "live" ? ` · ${d.status}` : ""}
          </div>
        </div>
      </div>
      <ul className="loki-phone-list">
        <SheetRow icon="chevron-right" label="Open chat" onClick={() => (onClose(), openDesk(d))} />
        {onPin && <SheetRow icon="pin" label={d.pinned ? "Unpin" : "Pin to the top"} onClick={() => (onPin(!d.pinned), onClose())} />}
        {canRename(d) && (
          <SheetRow icon="pencil" label="Rename" aside={onRename ? null : "Not connected"} disabled={!onRename} onClick={() => setRenaming(true)} />
        )}
        {canArchive(d) && (
          <SheetRow
            icon="archive"
            label={busy ? (archived ? "Restoring…" : "Archiving…") : archived ? "Restore to Chats" : "Archive"}
            aside={onArchive ? null : "Not connected"}
            disabled={!onArchive || busy}
            onClick={() => void archive()}
          />
        )}
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

export function SheetRow({
  icon,
  label,
  aside = null,
  disabled = false,
  onClick,
}: {
  icon: IconName;
  label: string;
  aside?: string | null;
  disabled?: boolean;
  onClick: () => void;
}) {
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

function HomeMenu({
  query,
  labelList,
  onQuery,
  onRefresh,
  onClose,
}: {
  query: string;
  labelList: LabelView[] | null;
  onQuery: (q: string) => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const on = labelQuery(query).labels;
  return (
    <Sheet label="Home menu" onClose={onClose} placement="bottom" className="loki-phone-sheet">
      <Field
        type="search"
        size="touch"
        name="desk-filter"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder="Filter chats"
        aria-label="Filter chats"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        enterKeyHint="done"
        onKeyDown={(e) => e.key === "Enter" && onClose()}
        data-1p-ignore
        data-form-type="other"
      />
      {!!labelList?.length && (
        <div className="loki-phone-pills" role="group" aria-label="Labels">
          {labelList.map((l) => (
            <button
              key={l.name}
              type="button"
              className="loki-phone-pill"
              aria-pressed={on.includes(l.name)}
              onClick={() => onQuery(toggleLabelTerm(query, l.name))}
            >
              <span className="loki-phone-pill-face">
                <span aria-hidden className="loki-label-dot" style={{ "--label-tone": labelColor(l.name, labelList) } as CSSProperties} />
                <span className="loki-phone-ellipsis">{l.name}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      <ul className="loki-phone-list">
        <SheetRow icon="refresh" label="Refresh chats" onClick={onRefresh} />
        <SheetRow icon="archive" label="Archived chats" onClick={() => (onClose(), navigate({ kind: "archive" }))} />
      </ul>
      <Button size="touch" tone="paper" block onClick={onClose}>
        Done
      </Button>
    </Sheet>
  );
}

function useRecentFolders(recentFolders: () => Promise<Partial<Record<string, string[]>>>) {
  const [recent, setRecent] = useState<Partial<Record<string, string[]>> | null>(null);
  useEffect(() => {
    let live = true;
    void recentFolders().then((r) => live && setRecent(r));
    return () => {
      live = false;
    };
  }, [recentFolders]);
  return recent;
}

function useNewDesk(
  agents: Array<{ id: string; name: string | null }>,
  defaultAgentId: string | null,
  recentFolders: () => Promise<Partial<Record<string, string[]>>>,
  onCreate: (agentId: string, folder: string, name: string) => Promise<Runtime>,
  onClose: () => void,
) {
  const [agentId, setAgentId] = useState<string | null>(defaultAgentId ?? agents.at(0)?.id ?? null);
  const [name, setName] = useState("");
  const recent = useRecentFolders(recentFolders);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agentName = agents.find((a) => a.id === agentId)?.name ?? null;
  const [picked, setPicked] = useState<string | null>(null);
  const folders = foldersOf(recent, agentId);
  const folder = chosenFolder(folders, picked);
  const canStart = !!agentId && !!folder && !busy;
  const start = async () => {
    if (!canStart || !agentId || !folder) return;
    setBusy(true);
    setError(null);
    try {
      const rt = await onCreate(agentId, folder, name.trim());
      onClose();
      openConversation(rt.agent_id, rt.conversation_id);
    } catch (err) {
      setError(messageOf(err));
    }
    setBusy(false);
  };
  return { agentId, setAgentId, name, setName, recent, agentName, folders, folder, setFolder: setPicked, busy, error, canStart, start };
}

function NewSheet({
  agents,
  defaultAgentId,
  recentFolders,
  onCreate,
  onClose,
}: {
  agents: Array<{ id: string; name: string | null }>;
  defaultAgentId: string | null;
  recentFolders: () => Promise<Partial<Record<string, string[]>>>;
  onCreate: (agentId: string, folder: string, name: string) => Promise<Runtime>;
  onClose: () => void;
}) {
  const { agentId, setAgentId, name, setName, recent, agentName, folders, folder, setFolder, busy, error, canStart, start } = useNewDesk(
    agents,
    defaultAgentId,
    recentFolders,
    onCreate,
    onClose,
  );
  return (
    <Sheet label="New chat" onClose={onClose} placement="bottom" className="loki-phone-sheet">
      <div className="loki-phone-sheet-copy">
        <div className="loki-phone-meta">New chat</div>
        <div className="loki-phone-title">{agentName ? `With ${agentName}` : "With an agent"}</div>
      </div>
      <AgentPicker agents={agents} agentId={agentId} onPick={setAgentId} />
      <Field
        size="touch"
        name="conversation-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name (optional)"
        aria-label="Chat name"
        autoComplete="off"
        data-1p-ignore
        data-form-type="other"
        enterKeyHint="go"
        onKeyDown={(e) => e.key === "Enter" && void start()}
      />
      <FolderPicker folders={folders} folder={folder} onPick={setFolder} />
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

function AgentPicker({
  agents,
  agentId,
  onPick,
}: {
  agents: Array<{ id: string; name: string | null }>;
  agentId: string | null;
  onPick: (id: string) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Agent" className="loki-phone-chips loki-phone-chips--wrap">
      {agents.map((a) => (
        <Chip key={a.id} touch role="radio" active={a.id === agentId} aria-checked={a.id === agentId} onClick={() => onPick(a.id)}>
          <AgentFace name={a.name} src={avatarUrl(a.id)} size={18} />
          {a.name ?? "agent"}
        </Chip>
      ))}
      {agents.length === 0 && <span className="loki-phone-meta">No agents yet. Is loki running on the Mac?</span>}
    </div>
  );
}

function FolderPicker({ folders, folder, onPick }: { folders: string[]; folder: string | null; onPick: (folder: string) => void }) {
  const [all, setAll] = useState(false);
  if (folders.length < 2) return null;
  const shown = shownFolders(folders, folder, all);
  const home = /^\/Users\/[^/]+/;
  return (
    <div role="radiogroup" aria-label="Folder" className="loki-phone-chips loki-phone-chips--wrap">
      {shown.map((f) => (
        <Chip key={f} touch role="radio" active={f === folder} aria-checked={f === folder} aria-label={f.replace(home, "~")} onClick={() => onPick(f)}>
          {folderName(f)}
        </Chip>
      ))}
      {!all && folders.length > shown.length && (
        <Chip touch onClick={() => setAll(true)}>
          {`More (${folders.length - shown.length})`}
        </Chip>
      )}
    </div>
  );
}

function FolderLine({ recent, folder, agentName }: { recent: Partial<Record<string, string[]>> | null; folder: string | null; agentName: string | null }) {
  const short = folder ? folder.replace(/^\/Users\/[^/]+/, "~") : null;
  return (
    <p className={folder || recent === null ? "loki-phone-meta loki-phone-wrap" : "loki-phone-error"}>
      {recent === null
        ? "Asking the Mac for folders…"
        : folder
          ? `In ${short}`
          : `${agentName ?? "This agent"} has no recent folder on the Mac; start its first chat there.`}
    </p>
  );
}
