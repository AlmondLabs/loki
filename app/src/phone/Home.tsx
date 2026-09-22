import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import type { Runtime } from "../../../core/attention/protocol.ts";
import { catchUpQueue } from "../../../core/attention/queue.ts";
import { ago } from "../board/model";
import { AgentFace } from "../desk/AgentChip";
import { avatarUrl } from "../desk/env";
import type { DeskSummary } from "../desk/useDesk";
import { BADGE } from "../desk/CatchUp";
import { Mark, agentChips, archivedDesks, liveDesks } from "../shell/DeskTree";
import { navigate } from "./router";
import { Button, Chip, Field, IconButton, Meta, Row, Sheet, Title } from "../components";
import { GUTTER, Heading, SAFE, Scroll, TopBar } from "./ui";

/** A desk's conversation, full screen; the shared sheet has none on a phone. */
function openDesk(d: DeskSummary) {
  if (d.agentId && d.conversationId) navigate({ kind: "conversation", agentId: d.agentId, conversationId: d.conversationId, prefill: null });
}

function openAttention(item: AttentionItem) {
  navigate({ kind: "conversation", agentId: item.agentId, conversationId: item.id, prefill: null });
}

/** A list drawn as rows: no bullets, no indent (Tailwind's preflight resets these too; stated here so the phone does not depend on it). */
const PLAIN_LIST = { listStyle: "none", margin: 0, padding: 0 } as const;

/**
 * Home is the desks tree on one column: every live conversation of every agent, pinned first then by
 * recency, each with its face, title, agent and time, and the same attention dot the desktop tree
 * gives it. A field filters by text, the chips by agent; the archive is folded at the bottom. The
 * plus starts a conversation with an agent in its most recent folder — the phone has no folder picker.
 */
export function Home({
  desks,
  agents,
  items,
  waiting,
  due,
  hidden = false,
  sub,
  banner,
  onOpenInbox,
  onOpenLearn,
  onRefresh,
  onPin,
  recentFolders,
  onCreate,
}: {
  desks: DeskSummary[];
  agents: Array<{ id: string; name: string }>;
  items: AttentionItem[];
  waiting: number;
  due: number;
  /** Keep Home mounted under child pages so search, filters, and scroll state survive the round trip. */
  hidden?: boolean;
  sub?: ReactNode;
  banner?: ReactNode;
  onOpenInbox: () => void;
  onOpenLearn: () => void;
  /** Ask the mod for the list again (on mount, and when the socket reopens). */
  onRefresh: () => void;
  onPin: (agentId: string, conversationId: string, pinned: boolean) => void;
  /** `folders_get`: the folders each agent worked in, most recent first. */
  recentFolders: () => Promise<Record<string, string[]>>;
  /** A new conversation through the app-server; resolves to its runtime. */
  onCreate: (agentId: string, folder: string, name: string) => Promise<Runtime>;
}) {
  const [query, setQuery] = useState("");
  const [agentFilter, setAgentFilter] = useState<string | null>(null);
  const [showArchive, setShowArchive] = useState(false);
  const [sheet, setSheet] = useState(false);

  useEffect(onRefresh, []); // eslint-disable-line react-hooks/exhaustive-deps

  const marks = useMemo(() => {
    const m = new Map<string, AttentionItem>();
    for (const i of items) m.set(`${i.agentId}/${i.id}`, i);
    return m;
  }, [items]);
  const chips = useMemo(() => agentChips(agents, desks), [agents, desks]);
  const q = query.trim().toLowerCase();
  const live = useMemo(() => liveDesks(desks, agentFilter, q), [desks, agentFilter, q]);
  // The shared sheet has no conversation to open on a phone, so it stays out of the archive fold here.
  const archive = useMemo(() => archivedDesks(desks, agentFilter, q).filter((d) => d.agentId && d.conversationId), [desks, agentFilter, q]);
  return (
    <div style={{ flex: 1, minHeight: 0, display: hidden ? "none" : "flex", flexDirection: "column", position: "relative" }}>
      <TopBar
        title="Home"
        sub={sub}
        height={sub ? 48 : 44}
        right={
          <IconButton label="new conversation" title="a new conversation" size={40} tone="paper" onClick={() => setSheet(true)} style={{ fontSize: 22, lineHeight: 1 }}>
            +
          </IconButton>
        }
      />
      {banner}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8, padding: `8px ${GUTTER.right} 0 ${GUTTER.left}` }}>
        <Shortcut label="Inbox" count={waiting} onClick={onOpenInbox} />
        <Shortcut label="Learn" count={due} onClick={onOpenLearn} />
      </div>

      {/* The filter and the agent chips, kept short: the list below is what the screen is for. */}
      <div style={{ flex: "0 0 auto", padding: `8px ${GUTTER.right} 0 ${GUTTER.left}`, display: "grid", gap: 6 }}>
        <Field
          type="search"
          size="md"
          name="desk-filter"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="type to filter"
          aria-label="filter desks"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          enterKeyHint="search"
          data-1p-ignore
          data-form-type="other"
        />
        <div role="group" aria-label="agent" style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 6, scrollbarWidth: "none", borderBottom: "1px solid var(--loki-border)" }}>
          <Chip touch active={agentFilter === null} aria-pressed={agentFilter === null} onClick={() => setAgentFilter(null)}>
            all <span style={{ opacity: 0.7 }}>{desks.filter((d) => d.status === "live" && d.scope !== "shared").length}</span>
          </Chip>
          {chips.map((c) => (
            <Chip key={c.id} touch active={agentFilter === c.id} aria-pressed={agentFilter === c.id} onClick={() => setAgentFilter(agentFilter === c.id ? null : c.id)}>
              <AgentFace name={c.name} src={avatarUrl(c.id)} size={16} />
              {c.name ?? "agent"} <span style={{ opacity: 0.7 }}>{c.count}</span>
            </Chip>
          ))}
        </div>
      </div>

      <Scroll style={{ padding: `0 ${GUTTER.right} 12px ${GUTTER.left}` }}>
        {waiting > 0 && <AttentionList items={catchUpQueue(items)} onOpen={openAttention} />}

        <Heading aside={live.length}>{query || agentFilter ? "matching desks" : "desks"}</Heading>
        <ul aria-label="desks" style={PLAIN_LIST}>
          {live.map((d) => (
            <DeskRow key={d.scope} desk={d} mark={marks.get(`${d.agentId}/${d.conversationId}`)} showFace={!agentFilter} onOpen={() => openDesk(d)} onPin={d.agentId && d.conversationId ? () => onPin(d.agentId!, d.conversationId!, !d.pinned) : null} />
          ))}
        </ul>
        {live.length === 0 && desks.length > 0 && <div style={{ padding: "24px 4px", fontSize: 13.5, color: "var(--loki-muted)", textAlign: "center" }}>no desks match</div>}
        {desks.length === 0 && <div style={{ padding: "24px 4px", fontSize: 13.5, color: "var(--loki-muted)", textAlign: "center" }}>reading the desks…</div>}
        {archive.length > 0 && (
          <div style={{ marginTop: 14, borderTop: "1px solid var(--loki-border)" }}>
            <Row touch onClick={() => setShowArchive((v) => !v)} aria-expanded={showArchive || !!q} style={{ gap: 8 }}>
              <span className="loki-label" style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 9.5 }}>
                <span aria-hidden style={{ display: "inline-block", transform: showArchive || q ? "rotate(90deg)" : "none", transition: "transform 120ms" }}>▸</span>
                archived
              </span>
              <Meta>· {archive.length}</Meta>
            </Row>
            {(showArchive || q) && (
              <ul aria-label="archived desks" style={PLAIN_LIST}>
                {archive.map((d) => (
                  <DeskRow key={d.scope} desk={d} mark={undefined} showFace={!agentFilter} onOpen={() => openDesk(d)} onPin={null} />
                ))}
              </ul>
            )}
          </div>
        )}
      </Scroll>

      {sheet && <NewSheet agents={chips} defaultAgentId={agentFilter} recentFolders={recentFolders} onCreate={onCreate} onClose={() => setSheet(false)} />}
    </div>
  );
}

function Shortcut({ label, count, onClick }: { label: string; count: number; onClick: () => void }) {
  return (
    <Row touch onClick={onClick} aria-label={`${label}${count > 0 ? `, ${count} ${label === "Learn" ? "due" : "waiting"}` : ""}`} style={{ minWidth: 0, minHeight: 52, padding: "7px 10px", border: "1px solid var(--loki-border)", borderRadius: 8, justifyContent: "space-between", background: "var(--loki-panel)" }}>
      <span className="loki-label" style={{ fontSize: 9.5, letterSpacing: "0.14em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      {count > 0 && <span style={{ flex: "0 0 auto", minWidth: 24, color: "var(--loki-accent)", fontFamily: "var(--loki-mono)", fontSize: 15, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{count > 99 ? "99+" : count}</span>}
    </Row>
  );
}

function AttentionList({ items, onOpen }: { items: AttentionItem[]; onOpen: (item: AttentionItem) => void }) {
  if (items.length === 0) return null;
  return (
    <section aria-label="waiting on you" style={{ marginBottom: 14 }}>
      <div className="loki-label" style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 9.5, padding: "8px 4px 6px" }}>
        waiting on you
        <Meta>· {items.length}</Meta>
      </div>
      <ul aria-label="attention" style={PLAIN_LIST}>
        {items.map((item) => {
          const badge = BADGE[item.status];
          return (
            <li key={`${item.agentId}/${item.id}`} style={{ borderBottom: "1px solid var(--loki-border)" }}>
              <Row touch onClick={() => onOpen(item)} aria-label={`${item.title ?? item.id}, ${badge.label}`} style={{ minWidth: 0, padding: "7px 4px" }}>
                <Mark item={item} status="live" size={8} />
                <AgentFace name={item.agentName} src={avatarUrl(item.agentId)} size={20} />
                <span style={{ flex: 1, minWidth: 0, display: "grid", gap: 1 }}>
                  <span style={{ fontFamily: "var(--loki-display)", fontSize: 15, lineHeight: 1.25, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.title ?? item.id}</span>
                  <Meta>{item.agentName ?? "agent"} · {badge.label}</Meta>
                </span>
              </Row>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** What a desk row is called: its title, or "new desk" while it is live and untitled, or its scope once archived. */
function deskName(d: DeskSummary): string {
  return d.title ?? (d.status === "live" ? "new desk" : d.scope);
}

/**
 * A long press: `onHold` fires after 550ms with the finger still down, and the tap that ends that press
 * is swallowed so the row does not also open. Owns the timer and the "held" flag; hands back the row's
 * pointer handlers and a wrapper for its click.
 */
function useHold(onHold: (() => void) | null) {
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  const start = () => {
    if (!onHold) return;
    held.current = false;
    hold.current = setTimeout(() => {
      held.current = true;
      onHold();
    }, 550);
  };
  const end = () => {
    if (hold.current) clearTimeout(hold.current);
    hold.current = null;
  };
  const tap = (fn: () => void) => () => {
    if (held.current) {
      held.current = false;
      return;
    }
    fn();
  };
  return { start, end, tap };
}

/** One desk: the mark, the face, the title over agent and time, the pin. 46px tall — a touch row with a hairline; a long press pins too. */
function DeskRow({ desk: d, mark, showFace, onOpen, onPin }: { desk: DeskSummary; mark: AttentionItem | undefined; showFace: boolean; onOpen: () => void; onPin: (() => void) | null }) {
  const hold = useHold(onPin);
  return (
    <li style={{ display: "flex", alignItems: "center", gap: 6, minHeight: 46, padding: "0 4px 0 0", borderBottom: "1px solid var(--loki-border)", opacity: d.status === "live" ? 1 : 0.7 }}>
      <Row
        touch
        onClick={hold.tap(onOpen)}
        onPointerDown={hold.start}
        onPointerUp={hold.end}
        onPointerCancel={hold.end}
        onPointerLeave={hold.end}
        onContextMenu={(e) => e.preventDefault()}
        aria-label={`${deskName(d)}, ${d.agentName ?? "agent"}${mark ? `, ${mark.status}` : ""}`}
        style={{ flex: 1, minWidth: 0, padding: "3px 6px", touchAction: "manipulation", userSelect: "none", WebkitUserSelect: "none" }}
      >
        <Mark item={mark} status={d.status} size={8} />
        {showFace && <AgentFace name={d.agentName} src={d.agentId ? avatarUrl(d.agentId) : null} size={20} />}
        <DeskTitle desk={d} />
      </Row>
      {onPin && (
        <IconButton label={d.pinned ? "unpin" : "pin"} size={40} onClick={onPin} aria-pressed={!!d.pinned} title={d.pinned ? "unpin" : "pin to the top"}>
          <Pin filled={!!d.pinned} />
        </IconButton>
      )}
    </li>
  );
}

/** The row's text: the title on one line, then agent, time and (when not live) status underneath. */
function DeskTitle({ desk: d }: { desk: DeskSummary }) {
  return (
    <span style={{ flex: 1, minWidth: 0, display: "grid", gap: 1 }}>
      <span style={{ fontFamily: "var(--loki-display)", fontSize: 15, lineHeight: 1.25, color: "var(--loki-fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{deskName(d)}</span>
      <Meta>
        {d.agentName ?? "agent"}
        {d.lastActive ? ` · ${ago(d.lastActive)}` : ""}
        {d.status !== "live" ? ` · ${d.status}` : ""}
      </Meta>
    </span>
  );
}

/** A drawing pin: filled when the desk is pinned. */
export function Pin({ filled, size = 16 }: { filled: boolean; size?: number }) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12.5 2.5 17.5 7.5 14 9l-1.5 4.5-6-6L11 6z" />
      <path d="M6.5 13.5 3 17" fill="none" />
    </svg>
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
    <Sheet label="new conversation" onClose={onClose} placement="bottom" style={{ padding: `14px ${GUTTER.right} calc(14px + ${SAFE.bottom}) ${GUTTER.left}`, display: "grid", gap: 14 }}>
      <div>
        <div className="loki-label" style={{ fontSize: 9.5 }}>new conversation</div>
        <Title style={{ marginTop: 4 }}>{agentName ? `with ${agentName}` : "with an agent"}</Title>
      </div>
      <AgentPicker agents={agents} agentId={agentId} onPick={setAgentId} />
      <Field size="touch" name="conversation-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="name · optional" aria-label="conversation name" autoComplete="off" data-1p-ignore data-form-type="other" enterKeyHint="go" onKeyDown={(e) => e.key === "Enter" && void start()} />
      <FolderLine recent={recent} folder={folder} agentName={agentName} />
      {error && <div role="alert" style={{ fontSize: 12, color: "var(--loki-negative)", fontFamily: "var(--loki-mono)" }}>{error}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <Button size="touch" onClick={onClose} style={{ flex: 1 }}>
          cancel
        </Button>
        <Button size="touch" tone="brass" onClick={() => void start()} disabled={!canStart} style={{ flex: 2 }}>
          {busy ? "starting…" : "start"}
        </Button>
      </div>
    </Sheet>
  );
}

/** The agent chips, one lit; a line instead when the harness has no agents yet. */
function AgentPicker({ agents, agentId, onPick }: { agents: Array<{ id: string; name: string | null }>; agentId: string | null; onPick: (id: string) => void }) {
  return (
    <div role="radiogroup" aria-label="agent" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {agents.map((a) => (
        <Chip key={a.id} touch active={a.id === agentId} aria-pressed={a.id === agentId} onClick={() => onPick(a.id)}>
          <AgentFace name={a.name} src={avatarUrl(a.id)} size={16} />
          {a.name ?? "agent"}
        </Chip>
      ))}
      {agents.length === 0 && <span style={{ fontSize: 12, color: "var(--loki-muted)" }}>no agents yet — is Letta Code running on the Mac?</span>}
    </div>
  );
}

/** Where the desk will start: waiting on the Mac, the folder (home shortened to ~), or why there is none. */
function FolderLine({ recent, folder, agentName }: { recent: Record<string, string[]> | null; folder: string | null; agentName: string | null }) {
  const short = folder ? folder.replace(/^\/Users\/[^/]+/, "~") : null;
  return (
    <div style={{ fontSize: 12, lineHeight: 1.5, color: folder ? "var(--loki-muted)" : "var(--loki-negative)", fontFamily: "var(--loki-mono)", letterSpacing: "0.06em", overflowWrap: "anywhere" }}>
      {recent === null ? "asking the Mac for folders…" : folder ? `in ${short}` : `${agentName ?? "this agent"} has no recent folder on the Mac; start its first desk there`}
    </div>
  );
}
