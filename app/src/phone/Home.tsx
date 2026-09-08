import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AttentionItem } from "../../../packages/core/src/attention/model.ts";
import type { Runtime } from "../../../packages/core/src/attention/protocol.ts";
import { ago } from "../board/model";
import { AgentFace } from "../desk/AgentChip";
import { avatarUrl } from "../desk/env";
import type { DeskSummary } from "../desk/useDesk";
import { Mark, agentChips, archivedDesks, liveDesks } from "../shell/DeskTree";
import { navigate } from "./router";
import { Chip, FIELD, GUTTER, Meta, SAFE, Scroll, TopBar, tap } from "./ui";

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
  const open = (d: DeskSummary) => {
    if (d.agentId && d.conversationId) navigate({ kind: "conversation", agentId: d.agentId, conversationId: d.conversationId, prefill: null });
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", position: "relative" }}>
      <TopBar
        title="Desks"
        sub={sub}
        right={
          <button type="button" onClick={() => setSheet(true)} aria-label="new conversation" title="a new conversation" style={{ ...tap("var(--loki-fg)"), minHeight: 36, minWidth: 36, padding: "4px 10px", fontSize: 22, lineHeight: 1 }}>
            +
          </button>
        }
      />
      {banner}

      <div style={{ flex: "0 0 auto", padding: `10px ${GUTTER.right} 0 ${GUTTER.left}`, display: "grid", gap: 8 }}>
        <input
          type="search"
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
          style={{ ...FIELD, minHeight: 40, padding: "8px 12px" }}
        />
        <div role="group" aria-label="agent" style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 10, scrollbarWidth: "none", borderBottom: "1px solid var(--loki-border)" }}>
          <Chip active={agentFilter === null} onClick={() => setAgentFilter(null)}>
            all <span style={{ opacity: 0.7 }}>{desks.filter((d) => d.status === "live" && d.scope !== "shared").length}</span>
          </Chip>
          {chips.map((c) => (
            <Chip key={c.id} active={agentFilter === c.id} onClick={() => setAgentFilter(agentFilter === c.id ? null : c.id)}>
              <AgentFace name={c.name} src={avatarUrl(c.id)} size={16} />
              {c.name ?? "agent"} <span style={{ opacity: 0.7 }}>{c.count}</span>
            </Chip>
          ))}
        </div>
      </div>

      <Scroll style={{ padding: `4px ${GUTTER.right} 24px ${GUTTER.left}` }}>
        <div role="list" aria-label="desks">
          {live.map((d) => (
            <Row key={d.scope} desk={d} mark={marks.get(`${d.agentId}/${d.conversationId}`)} showFace={!agentFilter} onOpen={() => open(d)} onPin={d.agentId && d.conversationId ? () => onPin(d.agentId!, d.conversationId!, !d.pinned) : null} />
          ))}
        </div>
        {live.length === 0 && desks.length > 0 && <div style={{ padding: "24px 4px", fontSize: 13.5, color: "var(--loki-muted)", textAlign: "center" }}>no desks match</div>}
        {desks.length === 0 && <div style={{ padding: "24px 4px", fontSize: 13.5, color: "var(--loki-muted)", textAlign: "center" }}>reading the desks…</div>}
        {archive.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <button type="button" onClick={() => setShowArchive((v) => !v)} aria-expanded={showArchive || !!q} className="loki-label" style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", minHeight: 40, padding: "4px 4px", border: "none", borderTop: "1px solid var(--loki-border)", background: "transparent", color: "var(--loki-muted)", cursor: "pointer", fontSize: 9.5, textAlign: "left" }}>
              <span aria-hidden style={{ display: "inline-block", transform: showArchive || q ? "rotate(90deg)" : "none", transition: "transform 120ms" }}>▸</span>
              archived
              <span style={{ fontFamily: "var(--loki-mono)", letterSpacing: "0.06em", textTransform: "none" }}>· {archive.length}</span>
            </button>
            {(showArchive || q) && (
              <div role="list" aria-label="archived desks">
                {archive.map((d) => (
                  <Row key={d.scope} desk={d} mark={undefined} showFace={!agentFilter} onOpen={() => open(d)} onPin={null} />
                ))}
              </div>
            )}
          </div>
        )}
      </Scroll>

      {sheet && <NewSheet agents={chips} defaultAgentId={agentFilter} recentFolders={recentFolders} onCreate={onCreate} onClose={() => setSheet(false)} />}
    </div>
  );
}

/** One desk: the mark, the face, the title over agent and time, the pin. 56px tall; a long press pins too. */
function Row({ desk: d, mark, showFace, onOpen, onPin }: { desk: DeskSummary; mark: AttentionItem | undefined; showFace: boolean; onOpen: () => void; onPin: (() => void) | null }) {
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
    <div role="listitem" style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 56, padding: "6px 4px", borderBottom: "1px solid var(--loki-border)", opacity: d.status === "live" ? 1 : 0.7 }}>
      <button
        type="button"
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
        style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 10, padding: 0, border: "none", background: "transparent", color: "var(--loki-fg)", textAlign: "left", cursor: "pointer", WebkitTapHighlightColor: "transparent", touchAction: "manipulation", userSelect: "none", WebkitUserSelect: "none" }}
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
      </button>
      {onPin && (
        <button type="button" onClick={onPin} aria-label={d.pinned ? "unpin" : "pin"} aria-pressed={!!d.pinned} title={d.pinned ? "unpin" : "pin to the top"} style={{ width: 40, height: 40, display: "grid", placeItems: "center", border: "none", borderRadius: 8, background: "transparent", color: d.pinned ? "var(--loki-fg)" : "var(--loki-muted)", opacity: d.pinned ? 1 : 0.55, cursor: "pointer", padding: 0, WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}>
          <Pin filled={!!d.pinned} />
        </button>
      )}
    </div>
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
    <div
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{ position: "absolute", inset: 0, background: "var(--loki-veil)", display: "flex", flexDirection: "column", justifyContent: "flex-end", zIndex: 10 }}
    >
      <div role="dialog" aria-label="new conversation" className="loki-sheet" style={{ background: "var(--loki-panel)", borderTop: "1px solid var(--loki-border)", borderRadius: "12px 12px 0 0", padding: `14px ${GUTTER.right} calc(14px + ${SAFE.bottom}) ${GUTTER.left}`, display: "grid", gap: 14, boxShadow: "var(--loki-shadow-sheet)" }}>
        <div>
          <div className="loki-label" style={{ fontSize: 9.5 }}>new conversation</div>
          <div style={{ fontFamily: "var(--loki-display)", fontSize: 17, color: "var(--loki-fg)", marginTop: 4 }}>{agentName ? `with ${agentName}` : "with an agent"}</div>
        </div>
        <div role="radiogroup" aria-label="agent" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {agents.map((a) => (
            <Chip key={a.id} active={a.id === agentId} onClick={() => setAgentId(a.id)}>
              <AgentFace name={a.name} src={avatarUrl(a.id)} size={16} />
              {a.name ?? "agent"}
            </Chip>
          ))}
          {agents.length === 0 && <span style={{ fontSize: 12, color: "var(--loki-muted)" }}>no agents yet — is Letta Code running on the Mac?</span>}
        </div>
        <input name="conversation-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="name · optional" aria-label="conversation name" autoComplete="off" data-1p-ignore data-form-type="other" enterKeyHint="go" onKeyDown={(e) => e.key === "Enter" && void start()} style={FIELD} />
        <div style={{ fontSize: 12, lineHeight: 1.5, color: folder ? "var(--loki-muted)" : "var(--loki-negative)", fontFamily: "var(--loki-mono)", letterSpacing: "0.06em", overflowWrap: "anywhere" }}>
          {recent === null ? "asking the Mac for folders…" : folder ? `in ${short}` : `${agentName ?? "this agent"} has no recent folder on the Mac; start its first desk there`}
        </div>
        {error && <div role="alert" style={{ fontSize: 12, color: "var(--loki-negative)", fontFamily: "var(--loki-mono)" }}>{error}</div>}
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" onClick={onClose} style={{ ...tap(), minHeight: 44, flex: 1 }}>
            cancel
          </button>
          <button type="button" onClick={() => void start()} disabled={!canStart} style={{ ...tap("var(--loki-fg)"), minHeight: 44, flex: 2, borderColor: canStart ? "var(--loki-fg)" : "var(--loki-border)", opacity: canStart ? 1 : 0.5 }}>
            {busy ? "starting…" : "start"}
          </button>
        </div>
      </div>
    </div>
  );
}
