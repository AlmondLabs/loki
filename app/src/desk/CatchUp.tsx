import { useEffect, useMemo, useRef, useState } from "react";
import type { TranscriptMessage } from "../../../shared/harness.ts";
import { ChatInput } from "../chat/ChatInput";
import { AgentChip } from "./AgentChip";
import type { AttentionItem, AttentionStatus } from "../attention/model";
import { ApprovalCard } from "../chat/ApprovalCard";
import { Transcript } from "../chat/Transcript";
import { btn, kbd } from "../chat/ui";

/**
 * Catch Up: one waiting conversation at a time, a decision per card.
 *   → / space  mark seen, next        ← keep unread, next
 *   A approve  D deny                 R reply       O open desk       Z undo     Esc close
 * Approvals first, then questions, failures, finished work.
 */
const ACTIONABLE: AttentionStatus[] = ["approval", "question", "failed", "done"];

const BADGE: Record<AttentionStatus, { label: string; color: string }> = {
  approval: { label: "needs approval", color: "var(--loci-accent)" },
  question: { label: "asked you", color: "#d7a54a" },
  failed: { label: "failed", color: "var(--loci-negative)" },
  done: { label: "finished", color: "var(--loci-positive)" },
  running: { label: "running", color: "var(--loci-muted)" },
  idle: { label: "", color: "var(--loci-muted)" },
};

const idOf = (i: AttentionItem) => `${i.agentId}/${i.id}`;

export function catchUpQueue(items: AttentionItem[]): AttentionItem[] {
  return items.filter((i) => ACTIONABLE.includes(i.status));
}

function ago(iso: string | null): string {
  if (!iso) return "";
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function CatchUp({
  open,
  onClose,
  items,
  onSeen,
  onUnread,
  onApprove,
  onReply,
  onOpenDesk,
  histories,
  loadHistory,
}: {
  open: boolean;
  onClose: () => void;
  items: AttentionItem[];
  /** Transcripts by "agentId/conversationId"; the deck asks for the current card's. */
  histories: Record<string, TranscriptMessage[]>;
  loadHistory: (item: AttentionItem) => void;
  onSeen: (item: AttentionItem) => void;
  onUnread: (item: AttentionItem) => void;
  onApprove: (item: AttentionItem, requestId: string, behavior: "allow" | "deny") => void;
  onReply: (item: AttentionItem, text: string) => void;
  onOpenDesk: (agentId: string, conversationId: string) => void;
}) {
  // The current card never moves under your hands, but the queue stays live: new items join at the end,
  // items resolved elsewhere drop out, decided ones fall out. The count in the header follows.
  const [queue, setQueue] = useState<AttentionItem[]>([]);
  const [decided, setDecided] = useState<Array<{ item: AttentionItem; action: "seen" | "unread" }>>([]);
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState("");
  const [flash, setFlash] = useState<string | null>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const live = useMemo(() => new Map(items.map((i) => [idOf(i), i])), [items]);

  useEffect(() => {
    if (!open) return;
    setQueue(catchUpQueue(items));
    setDecided([]);
    setReplying(false);
    setDraft("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Live merge while open.
  useEffect(() => {
    if (!open) return;
    const actionable = catchUpQueue(items);
    const actionableIds = new Set(actionable.map(idOf));
    const decidedIds = new Set(decided.map((d) => idOf(d.item)));
    setQueue((q) => {
      const keep = q.filter((i, idx) => idx === 0 || actionableIds.has(idOf(i))); // never yank the current card
      const known = new Set(keep.map(idOf));
      const fresh = actionable.filter((i) => !known.has(idOf(i)) && !decidedIds.has(idOf(i)));
      return fresh.length || keep.length !== q.length ? [...keep, ...fresh] : q;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, open]);

  const total = queue.length + decided.length;
  /** Live: what is actually waiting right now, whatever this pass has decided. */
  const liveWaiting = catchUpQueue(items).length;

  const current = queue[0] ? (live.get(idOf(queue[0])) ?? queue[0]) : undefined;
  const history = current ? histories[idOf(current)] : undefined;
  const threadRef = useRef<HTMLDivElement>(null);

  // Fetch the thread when a card becomes current (and again when its item changes, e.g. a reply landed).
  useEffect(() => {
    if (open && current) loadHistory(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, current?.agentId, current?.id, current?.lastMessageAt]);

  // Newest at the bottom, scrolled into view.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history, current?.id]);

  const advance = (action: "seen" | "unread") => {
    if (!current) return;
    if (action === "seen") onSeen(current);
    else onUnread(current);
    setDecided((d) => [...d, { item: current, action }]);
    setQueue((q) => q.slice(1));
    setReplying(false);
    setDraft("");
  };
  const undo = () => {
    const last = decided[decided.length - 1];
    if (!last) return;
    if (last.action === "seen") onUnread(last.item);
    setDecided((d) => d.slice(0, -1));
    setQueue((q) => [last.item, ...q]);
  };
  const approve = (behavior: "allow" | "deny") => {
    if (!current?.pendingApproval) return;
    onApprove(current, current.pendingApproval.requestId, behavior);
    setFlash(behavior === "allow" ? "approved" : "denied");
    setTimeout(() => setFlash(null), 900);
    advance("seen");
  };
  const sendReply = () => {
    const text = draft.trim();
    if (!current || !text) return;
    onReply(current, text);
    setFlash("sent");
    setTimeout(() => setFlash(null), 900);
    advance("seen");
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (replying) return; // the reply box handles its own keys (enter sends, shift+enter newline, esc cancels)
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case "ArrowRight":
        case " ":
          e.preventDefault();
          advance("seen");
          break;
        case "ArrowLeft":
          e.preventDefault();
          advance("unread");
          break;
        case "a":
        case "A":
          if (current?.pendingApproval) approve("allow");
          break;
        case "d":
        case "D":
          if (current?.pendingApproval) approve("deny");
          break;
        case "r":
        case "R":
          if (current) {
            e.preventDefault();
            setReplying(true);
            setTimeout(() => replyRef.current?.focus(), 0);
          }
          break;
        case "o":
        case "O":
          if (current) {
            onOpenDesk(current.agentId, current.id);
            onClose();
          }
          break;
        case "z":
        case "Z":
          undo();
          break;
        case "Escape":
          onClose();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, replying, current, decided, draft]);

  if (!open) return null;

  const badge = current ? BADGE[current.status] : null;
  const position = total - queue.length + 1;

  return (
    <div
      onPointerDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
      style={{ position: "absolute", inset: 0, background: "rgba(8,8,10,0.72)", display: "grid", placeItems: "center", zIndex: 200000 }}
    >
      <div style={{ width: 1100, maxWidth: "94vw", height: "86vh", display: "flex", flexDirection: "column" }}>
        <div className="loci-label" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "0 6px 10px" }}>
          <span>catch up</span>
          <span>
            {current ? `${position} of ${total} · ${queue.length} left in this pass` : total ? `${total} of ${total}` : ""}
            <span style={{ marginLeft: 14, color: liveWaiting > 0 ? "var(--loci-fg)" : "var(--loci-muted)" }}>{liveWaiting} waiting</span>
          </span>
        </div>

        {!current ? (
          <div style={{ background: "var(--loci-panel)", border: "1px solid var(--loci-border)", borderRadius: 14, padding: "36px 28px", textAlign: "center" }}>
            <div style={{ fontFamily: "var(--loci-display)", fontSize: 22, color: "var(--loci-fg)" }}>You're caught up.</div>
            <div style={{ fontSize: 12, color: "var(--loci-muted)", marginTop: 8 }}>
              {items.filter((i) => i.status === "running").length > 0
                ? `${items.filter((i) => i.status === "running").length} still running`
                : "nothing is waiting on you"}
            </div>
            <div style={{ marginTop: 18, fontSize: 11, color: "var(--loci-muted)", fontFamily: "var(--loci-mono)" }}>{decided.length ? "z undo · " : ""}esc close</div>
          </div>
        ) : (
          <div
            key={idOf(current)}
            style={{
              flex: 1,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
              background: "var(--loci-panel)",
              border: `1px solid ${badge?.color ?? "var(--loci-border)"}`,
              borderRadius: 14,
              boxShadow: "0 30px 90px rgba(0,0,0,0.6)",
              overflow: "hidden",
              animation: "loci-card-in 180ms ease-out",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "14px 18px", borderBottom: "1px solid var(--loci-border)" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: "var(--loci-display)", fontSize: 17, color: "var(--loci-fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{current.title ?? current.id}</div>
                <div style={{ fontSize: 11, color: "var(--loci-muted)", marginTop: 4, fontFamily: "var(--loci-mono)", display: "flex", alignItems: "center", gap: 10 }}>
                  <AgentChip name={current.agentName} />
                  <span>{current.status === "approval" ? `waiting ${ago(current.pendingApproval?.at ?? current.lastMessageAt)}` : ago(current.lastMessageAt)}</span>
                </div>
              </div>
              <span style={{ fontSize: 11, letterSpacing: "0.08em", color: badge?.color, border: `1px solid ${badge?.color}`, borderRadius: 999, padding: "3px 10px", whiteSpace: "nowrap" }}>
                {flash ?? badge?.label}
              </span>
            </div>

            <div ref={threadRef} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px 20px", fontSize: 13.5, lineHeight: 1.5, color: "var(--loci-fg)" }}>
              {!history && <div style={{ color: "var(--loci-muted)", fontSize: 12 }}>loading the thread…</div>}
              {history && history.length === 0 && <div style={{ color: "var(--loci-muted)", fontSize: 12 }}>no transcript on disk</div>}
              {history && <Transcript rows={history} />}
              {current.status === "failed" && current.error && (
                <div style={{ color: "var(--loci-negative)", fontFamily: "var(--loci-mono)", fontSize: 12, marginTop: 12 }}>{current.error}</div>
              )}
            </div>

            {current.status === "approval" && current.pendingApproval && <ApprovalCard approval={current.pendingApproval} />}

            {replying ? (
              <div style={{ display: "flex", gap: 8, padding: 12, borderTop: "1px solid var(--loci-border)", alignItems: "flex-end" }}>
                <ChatInput
                  ref={replyRef}
                  value={draft}
                  onChange={setDraft}
                  onSubmit={sendReply}
                  onEscape={() => setReplying(false)}
                  placeholder="reply… (enter to send · shift+enter new line · esc to cancel)"
                />
                <button onClick={sendReply} style={btn("var(--loci-accent)")}>send</button>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 8, padding: 12, borderTop: "1px solid var(--loci-border)", alignItems: "center", flexWrap: "wrap" }}>
                {current.pendingApproval && (
                  <>
                    <button onClick={() => approve("allow")} style={btn("var(--loci-positive)")}>approve <kbd style={kbd}>A</kbd></button>
                    <button onClick={() => approve("deny")} style={btn("var(--loci-negative)")}>deny <kbd style={kbd}>D</kbd></button>
                  </>
                )}
                <button onClick={() => { setReplying(true); setTimeout(() => replyRef.current?.focus(), 0); }} style={btn()}>reply <kbd style={kbd}>R</kbd></button>
                <button onClick={() => { onOpenDesk(current.agentId, current.id); onClose(); }} style={btn()}>open desk <kbd style={kbd}>O</kbd></button>
                <span style={{ flex: 1 }} />
                <button onClick={() => advance("unread")} style={btn()}>← keep unread</button>
                <button onClick={() => advance("seen")} style={btn("var(--loci-fg)")}>next →</button>
              </div>
            )}
          </div>
        )}
        <div style={{ textAlign: "center", marginTop: 12, fontSize: 10, color: "var(--loci-muted)", letterSpacing: "0.08em", fontFamily: "var(--loci-mono)" }}>
          → seen · ← keep unread · A approve · D deny · R reply · O open · Z undo · esc close
        </div>
      </div>
      <style>{`@keyframes loci-card-in { from { opacity: 0; transform: translateY(10px) scale(0.985); } to { opacity: 1; transform: none; } }`}</style>
    </div>
  );
}


