import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AttentionItem } from "../../../packages/core/src/attention/model.ts";
import type { Runtime } from "../../../packages/core/src/attention/protocol.ts";
import { ago } from "../board/model";
import { AgentFace } from "../desk/AgentChip";
import { avatarUrl } from "../desk/env";
import type { DeskSummary } from "../desk/useDesk";
import { Mark, agentChips, archivedDesks, liveDesks } from "../shell/DeskTree";
import { navigate } from "./router";
import { Button, Chip, Field, IconButton, Meta, Row, Sheet, Title } from "../ui";
import { GUTTER, SAFE, Scroll, TopBar } from "./ui";

/** A desk's conversation, full screen; the shared sheet has none on a phone. */
function openDesk(d: DeskSummary) {
  if (d.agentId && d.conversationId) navigate({ kind: "conversation", agentId: d.agentId, conversationId: d.conversationId, prefill: null });
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
  sub,
  banner,
  onRefresh,
  onPin,
  recentFolders,
  onCreate,
}: {
  desks: DeskSummary[];
  agents: Array<{ id: string; name: string }>;
  items: AttentionItem[];
  sub?: ReactNode;
  banner?: ReactNode;
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
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", position: "relative" }}>
      <TopBar
        title="Desks"
        sub={sub}
        right={
          <IconButton label="new conversation" title="a new conversation" size={40} tone="paper" onClick={() => setSheet(true)} style={{ fontSize: 22, lineHeight: 1 }}>
            +
          </IconButton>
        }
      />
      {banner}

      <div style={{ flex: "0 0 auto", padding: `10px ${GUTTER.right} 0 ${GUTTER.left}`, display: "grid", gap: 8 }}>
        <Field
          type="search"
          size="touch"
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
        <div role="group" aria-label="agent" style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 10, scrollbarWidth: "none", borderBottom: "1px solid var(--loki-border)" }}>
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

      <Scroll style={{ padding: `4px ${GUTTER.right} 24px ${GUTTER.left}` }}>
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

/** One desk: the mark, the face, the title over agent and time, the pin. 56px tall; a long press pins too. */
function DeskRow({ desk: d, mark, showFace, onOpen, onPin }: { desk: DeskSummary; mark: AttentionItem | undefined; showFace: boolean; onOpen: () => void; onPin: (() => void) | null }) {
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  const startHold = () => {
    if (!onPin) return;
    held.current = false;
    hold.current = setTimeout(() => {
      held.current = true;
      onPin();
    }, 550);
  };
  const endHold = () => {
    if (hold.current) clearTimeout(hold.current);
    hold.current = null;
  };
  return (
    <li style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 56, padding: "6px 4px 6px 0", borderBottom: "1px solid var(--loki-border)", opacity: d.status === "live" ? 1 : 0.7 }}>
      <Row
        touch
        onClick={() => {
          if (held.current) {
            held.current = false;
            return;
          }
          onOpen();
        }}
        onPointerDown={startHold}
        onPointerUp={endHold}
        onPointerCancel={endHold}
        onPointerLeave={endHold}
        onContextMenu={(e) => e.preventDefault()}
        aria-label={`${d.title ?? (d.status === "live" ? "new desk" : d.scope)}, ${d.agentName ?? "agent"}${mark ? `, ${mark.status}` : ""}`}
        style={{ flex: 1, minWidth: 0, touchAction: "manipulation", userSelect: "none", WebkitUserSelect: "none" }}
      >
        <Mark item={mark} status={d.status} size={8} />
        {showFace && <AgentFace name={d.agentName} src={d.agentId ? avatarUrl(d.agentId) : null} size={20} />}
        <span style={{ flex: 1, minWidth: 0, display: "grid", gap: 3 }}>
          <span style={{ fontFamily: "var(--loki-display)", fontSize: 15, color: "var(--loki-fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.title ?? (d.status === "live" ? "new desk" : d.scope)}</span>
          <Meta>
            {d.agentName ?? "agent"}
            {d.lastActive ? ` · ${ago(d.lastActive)}` : ""}
            {d.status !== "live" ? ` · ${d.status}` : ""}
          </Meta>
        </span>
      </Row>
      {onPin && (
        <IconButton label={d.pinned ? "unpin" : "pin"} size={40} onClick={onPin} aria-pressed={!!d.pinned} title={d.pinned ? "unpin" : "pin to the top"}>
          <Pin filled={!!d.pinned} />
        </IconButton>
      )}
    </li>
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

/**
 * The plus: pick an agent, name it if you like, start. The folder is the agent's most recent one on
 * the Mac; when it has none, the sheet says so and start stays off — choosing a folder is the Mac's job.
 */
function NewSheet({ agents, defaultAgentId, recentFolders, onCreate, onClose }: { agents: Array<{ id: string; name: string | null }>; defaultAgentId: string | null; recentFolders: () => Promise<Record<string, string[]>>; onCreate: (agentId: string, folder: string, name: string) => Promise<Runtime>; onClose: () => void }) {
  const [agentId, setAgentId] = useState<string | null>(defaultAgentId ?? agents[0]?.id ?? null);
  const [name, setName] = useState("");
  const [recent, setRecent] = useState<Record<string, string[]> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void recentFolders().then((r) => live && setRecent(r));
    return () => {
      live = false;
    };
  }, [recentFolders]);
  const agentName = agents.find((a) => a.id === agentId)?.name ?? null;
  const folder = agentId && recent ? recent[agentId]?.[0] ?? null : null;
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
  const short = folder ? folder.replace(/^\/Users\/[^/]+/, "~") : null;
  return (
    <Sheet label="new conversation" onClose={onClose} placement="bottom" style={{ padding: `14px ${GUTTER.right} calc(14px + ${SAFE.bottom}) ${GUTTER.left}`, display: "grid", gap: 14 }}>
      <div>
        <div className="loki-label" style={{ fontSize: 9.5 }}>new conversation</div>
        <Title style={{ marginTop: 4 }}>{agentName ? `with ${agentName}` : "with an agent"}</Title>
      </div>
      <div role="radiogroup" aria-label="agent" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {agents.map((a) => (
          <Chip key={a.id} touch active={a.id === agentId} aria-pressed={a.id === agentId} onClick={() => setAgentId(a.id)}>
            <AgentFace name={a.name} src={avatarUrl(a.id)} size={16} />
            {a.name ?? "agent"}
          </Chip>
        ))}
        {agents.length === 0 && <span style={{ fontSize: 12, color: "var(--loki-muted)" }}>no agents yet — is Letta Code running on the Mac?</span>}
      </div>
      <Field size="touch" name="conversation-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="name · optional" aria-label="conversation name" autoComplete="off" data-1p-ignore data-form-type="other" enterKeyHint="go" onKeyDown={(e) => e.key === "Enter" && void start()} />
      <div style={{ fontSize: 12, lineHeight: 1.5, color: folder ? "var(--loki-muted)" : "var(--loki-negative)", fontFamily: "var(--loki-mono)", letterSpacing: "0.06em", overflowWrap: "anywhere" }}>
        {recent === null ? "asking the Mac for folders…" : folder ? `in ${short}` : `${agentName ?? "this agent"} has no recent folder on the Mac; start its first desk there`}
      </div>
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
