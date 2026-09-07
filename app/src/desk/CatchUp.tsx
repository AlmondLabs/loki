import { useEffect, useMemo, useRef, useState } from "react";
import { ChatInput } from "../chat/ChatInput";
import { AgentChip, AgentFace } from "./AgentChip";
import { avatarUrl } from "./env";
import type { AttentionItem, AttentionStatus } from "../../../packages/core/src/attention/model.ts";
import { catchUpQueue, idOf, mergeQueue, snoozedItems, stampOf, type Decision } from "../../../packages/core/src/attention/queue.ts";
import { formatIn, ordinal, type Snooze } from "../../../packages/core/src/attention/snooze.ts";
import type { ImageAttachment } from "../../../packages/core/src/attention/content.ts";
import { ApprovalCard } from "../chat/ApprovalCard";
import { QuestionCard } from "../chat/QuestionCard";
import { Transcript, type TranscriptRow } from "../chat/Transcript";
import { btn, kbd } from "../chat/ui";
import { registerActions } from "../shell/keymap";
import { ModelChip, ModelPicker, type ModelEntry } from "../chat/ModelPicker";
import { ModeChip, ModeMenu, isPermissionMode, type PermissionMode } from "../chat/PermissionMode";

/**
 * Catch Up: one waiting conversation at a time, a decision per card.
 *   → / space  mark seen, next        ← keep unread, next
 *   A approve  D deny                 R reply       O open desk       Z undo     Esc close
 * Approvals first, then questions, failures, finished work.
 */

const BADGE: Record<AttentionStatus, { label: string; color: string }> = {
  approval: { label: "needs approval", color: "var(--loki-accent)" },
  question: { label: "asked you", color: "var(--loki-accent)" },
  failed: { label: "failed", color: "var(--loki-negative)" },
  done: { label: "finished", color: "var(--loki-positive)" },
  running: { label: "running", color: "var(--loki-muted)" },
  idle: { label: "", color: "var(--loki-muted)" },
};

export { catchUpQueue };

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
  onLater,
  onUnsnooze,
  snoozes,
  onApprove,
  onAnswer,
  onReply,
  onOpenDesk,
  conversation,
  loadHistory,
  modelFor,
  models = null,
  onLoadModels,
  onPickModel,
  modeFor,
  onPickMode,
}: {
  open: boolean;
  onClose: () => void;
  items: AttentionItem[];
  /** "Later" with backoff, and its undo. */
  onLater: (item: AttentionItem) => void;
  onUnsnooze: (item: AttentionItem) => void;
  /** Raw deferral records by "agentId/conversationId" (expired ones included) for the "nth time around" label. */
  snoozes: Record<string, Snooze>;
  /** The live conversation model behind a card; `rows` is undefined until loaded. */
  conversation: (agentId: string, conversationId: string) => { rows: TranscriptRow[] | undefined; status: "idle" | "thinking" | "streaming"; mode?: string | null };
  loadHistory: (item: AttentionItem) => void;
  onSeen: (item: AttentionItem) => void;
  onUnread: (item: AttentionItem) => void;
  onApprove: (item: AttentionItem, requestId: string, behavior: "allow" | "deny") => void;
  onReply: (item: AttentionItem, text: string, images?: ImageAttachment[]) => void;
  onAnswer: (item: AttentionItem, requestId: string, answers: Record<string, string | string[]>) => void;
  onOpenDesk: (agentId: string, conversationId: string) => void;
  /** The model a card's conversation runs on, and the switcher (shared with the desk chat). */
  modelFor?: (agentId: string, conversationId: string) => string | null;
  models?: ModelEntry[] | null;
  onLoadModels?: () => void;
  onPickModel?: (item: AttentionItem, handle: string) => Promise<void>;
  /** The permission mode of a card's conversation, and its setter. */
  modeFor?: (agentId: string, conversationId: string) => string | null;
  onPickMode?: (item: AttentionItem, mode: PermissionMode) => Promise<void>;
}) {
  const [modelPicker, setModelPicker] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [modeMenu, setModeMenu] = useState(false);
  const [changingMode, setChangingMode] = useState(false);
  // The current card never moves under your hands, but the queue stays live: new items join at the end,
  // items resolved elsewhere drop out, decided ones fall out. The count in the header follows.
  const [queue, setQueue] = useState<AttentionItem[]>([]);
  const [decided, setDecided] = useState<Decision[]>([]);
  // The reply box is always there and takes focus with each card. While you are in it,
  // letters type; the deck's single-key shortcuts return when you press Esc (or click out).
  const [typingRaw, setTyping] = useState(false);
  /** S: bring deferred cards back into this pass, in a quieter style. */
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [flash, setFlash] = useState<string | null>(null);
  /** Replies sent this pass. A reply keeps you on the card; only next/later/approve/deny move it. */
  const [replies, setReplies] = useState(0);
  /** Which way the last move went; the next card enters from that side. */
  const [dir, setDir] = useState<"next" | "back">("next");
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const live = useMemo(() => new Map(items.map((i) => [idOf(i), i])), [items]);

  useEffect(() => {
    if (!open) return;
    setQueue(catchUpQueue(items, showSnoozed));
    setDecided([]);
    setReplies(0);
    setDraft("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Live merge while open.
  useEffect(() => {
    if (!open) return;
    setQueue((q) => mergeQueue(q, items, decided, showSnoozed));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, open, showSnoozed]);

  const total = queue.length + decided.length;
  /** Live: what is actually waiting right now, whatever this pass has decided. */
  const liveWaiting = catchUpQueue(items).length;
  const snoozed = snoozedItems(items);
  const nextDue = snoozed.map((i) => i.snooze!.until).sort()[0] ?? null;

  const current = queue[0] ? (live.get(idOf(queue[0])) ?? queue[0]) : undefined;
  // The reply box unmounts with the last card without a blur event; without a card there is nothing to type into.
  const typing = typingRaw && !!current;
  const thread = current ? conversation(current.agentId, current.id) : undefined;
  const history = thread?.rows;
  const threadRef = useRef<HTMLDivElement>(null);

  // Fetch the thread once when a card becomes current; live rows stream in on top of it.
  useEffect(() => {
    if (open && current) loadHistory(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, current?.agentId, current?.id]);

  // Newest at the bottom, scrolled into view.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history?.length, thread?.status, current?.id]);

  const advance = (action: "seen" | "unread", via: Decision["via"] = action === "seen" ? "next" : "later") => {
    if (!current) return;
    if (action === "seen") onSeen(current);
    else {
      onUnread(current);
      if (!current.pendingApproval) onLater(current); // approvals never snooze
    }
    setDir("next");
    setDecided((d) => [...d, { item: current, action, via, stamp: stampOf(current) }]);
    setQueue((q) => q.slice(1));
    setDraft("");
    setImages([]);
  };
  const undo = () => {
    const last = decided[decided.length - 1];
    if (!last) return;
    if (last.action === "seen") onUnread(last.item);
    else onUnsnooze(last.item);
    setDir("back");
    setDecided((d) => d.slice(0, -1));
    setQueue((q) => [last.item, ...q]);
  };
  const approve = (behavior: "allow" | "deny") => {
    if (!current?.pendingApproval) return;
    onApprove(current, current.pendingApproval.requestId, behavior);
    setFlash(behavior === "allow" ? "approved" : "denied");
    setTimeout(() => setFlash(null), 900);
    advance("seen", behavior === "allow" ? "approve" : "deny");
  };
  // Sending a reply keeps the card: you may want to watch the answer arrive. Moving on is yours (→ / ←).
  const sendReply = () => {
    const text = draft.trim();
    if (!current || (!text && !images.length)) return;
    const item = current;
    if (item.pendingQuestion && item.pendingQuestion.questions.length === 1 && text && !images.length) {
      onAnswer(item, item.pendingQuestion.requestId, { [item.pendingQuestion.questions[0].question]: text }); // a typed reply is the answer
      setDraft("");
      setImages([]);
      return;
    }
    onReply(item, text, images);
    setReplies((n) => n + 1);
    setDraft("");
    setImages([]);
    setFlash("sent");
    setTimeout(() => setFlash(null), 900);
  };

  // The deck's actions, by keymap id (the shell's key handler and the menu dispatch to them). The keymap
  // decides which keys reach here while the reply box has focus: ⌘] ⌘[ ⌘↵ ⌘⌫ ⌘O ⌘S do, plain letters do not.
  useEffect(() => {
    if (!open) return;
    return registerActions({
      "inbox.next": () => advance("seen"),
      "inbox.later": () => advance("unread"),
      "inbox.approve": () => {
        if (current?.pendingApproval) approve("allow");
      },
      "inbox.deny": () => {
        if (current?.pendingApproval) approve("deny");
      },
      "inbox.reply": () => replyRef.current?.focus(),
      "inbox.open": () => {
        if (!current) return;
        onOpenDesk(current.agentId, current.id);
        onClose();
      },
      "inbox.undo": () => undo(),
      "inbox.snoozed": () => setShowSnoozed((v) => !v),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, typing, current, decided, draft]);
  // Esc with the box idle closes the deck (the box handles its own Esc: keep a draft, or close when empty).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !typing) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, typing]);

  // Each card arrives with the reply box focused, so you can just type — except approvals,
  // where the decision is the point: A and D must work at once, so the box waits for R or a click.
  useEffect(() => {
    if (!open || !current) return;
    if (current.pendingApproval || current.pendingQuestion) replyRef.current?.blur();
    else setTimeout(() => replyRef.current?.focus(), 0); // after the keystroke that brought this card has finished
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, current?.agentId, current?.id, !!current?.pendingApproval, !!current?.pendingQuestion]);

  if (!open) return null;

  const badge = current ? BADGE[current.status] : null;
  const position = total - queue.length + 1;
  /** This conversation was already decided in this pass and has come back with something new. */
  const cameBack = !!current && decided.some((d) => idOf(d.item) === idOf(current));
  /** Today's deferral history for the current card, expired or not. */
  const priorSnooze = current ? snoozes[idOf(current)] : undefined;
  const timesAround = priorSnooze && priorSnooze.stamp === stampOf(current!) ? priorSnooze.skips + 1 : 0;

  return (
    <div
      onPointerDown={(e) => e.stopPropagation()}
      style={{ position: "absolute", inset: 0, background: "var(--loki-bg)", display: "grid", gridTemplateRows: "100%", justifyItems: "center", padding: "20px 24px 16px", boxSizing: "border-box", animation: "loki-veil 160ms ease-out both" }}
    >
      <div style={{ width: 1100, maxWidth: "100%", height: "100%", minHeight: 0, display: "flex", flexDirection: "column", position: "relative" }}>
        <div className="loki-label" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "0 6px 10px" }}>
          <span>catch up</span>
          <span>
            {current ? `${position} of ${total} · ${queue.length} left in this pass` : total ? `${total} of ${total}` : ""}
            <span style={{ marginLeft: 14, color: liveWaiting > 0 ? "var(--loki-fg)" : "var(--loki-muted)" }}>{liveWaiting} waiting</span>
            {snoozed.length > 0 && <span style={{ marginLeft: 14, color: showSnoozed ? "var(--loki-accent)" : "var(--loki-muted)" }}>{snoozed.length} snoozed{showSnoozed ? " · shown" : ""}</span>}
          </span>
        </div>
        {total > 0 && (
          <div aria-hidden style={{ height: 2, margin: "0 6px 10px", background: "var(--loki-border)", borderRadius: 1, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${Math.round(((total - queue.length) / total) * 100)}%`, background: "var(--loki-accent)", transition: "width 240ms ease-out" }} />
          </div>
        )}

        {!current ? (
          <div style={{ background: "var(--loki-panel)", border: "1px solid var(--loki-border)", borderRadius: 12, padding: "36px 28px", textAlign: "center" }}>
            <div style={{ fontFamily: "var(--loki-display)", fontSize: 22, color: "var(--loki-fg)" }}>You're caught up.</div>
            <div style={{ fontSize: 12, color: "var(--loki-muted)", marginTop: 8 }}>
              {items.filter((i) => i.status === "running").length > 0
                ? `${items.filter((i) => i.status === "running").length} still running`
                : "nothing is waiting on you"}
            </div>
            {snoozed.length > 0 && nextDue && (
              <div style={{ fontSize: 12, color: "var(--loki-accent)", marginTop: 6 }}>
                {snoozed.length} snoozed · next back in {formatIn(nextDue)} · <span style={{ fontFamily: "var(--loki-mono)", fontSize: 10.5 }}>S</span> to show them now
              </div>
            )}
            {(decided.length > 0 || replies > 0) && (
              <div style={{ fontSize: 12, color: "var(--loki-fg)", marginTop: 10, fontFamily: "var(--loki-mono)", letterSpacing: "0.06em" }}>
                {[
                  `${decided.length} cleared this pass`,
                  ...(["approve", "deny", "later"] as const)
                    .map((k) => [k, decided.filter((d) => d.via === k).length] as const)
                    .filter(([, n]) => n > 0)
                    .map(([k, n]) => `${n} ${k === "approve" ? "approved" : k === "deny" ? "denied" : "for later"}`),
                  ...(replies > 0 ? [`${replies} ${replies === 1 ? "reply" : "replies"}`] : []),
                ].join(" · ")}
              </div>
            )}
            <div style={{ fontSize: 12, color: "var(--loki-muted)", marginTop: 6 }}>anything new lands here while this stays open</div>
            <div style={{ marginTop: 18, fontSize: 10.5, color: "var(--loki-muted)", fontFamily: "var(--loki-mono)" }}>{decided.length ? "z undo · " : ""}esc close</div>
          </div>
        ) : (
          <div
            key={idOf(current)}
            style={{
              flex: 1,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
              background: "var(--loki-panel)",
              border: `1px solid ${badge?.color ?? "var(--loki-border)"}`,
              borderRadius: 12,
              boxShadow: "var(--loki-shadow-sheet)",
              overflow: "hidden",
              animation: `${dir === "back" ? "loki-card-back" : "loki-card-next"} 200ms ease-out`,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "14px 18px", borderBottom: "1px solid var(--loki-border)" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: "var(--loki-display)", fontSize: 17, color: "var(--loki-fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{current.title ?? current.id}</div>
                <div style={{ fontSize: 10.5, color: "var(--loki-muted)", marginTop: 4, fontFamily: "var(--loki-mono)", display: "flex", alignItems: "center", gap: 10 }}>
                  <AgentFace name={current.agentName} src={avatarUrl(current.agentId)} size={18} />
                  <AgentChip name={current.agentName} />
                  <span>{current.status === "approval" ? `waiting ${ago(current.pendingApproval?.at ?? current.lastMessageAt)}` : ago(current.lastMessageAt)}</span>
                  {cameBack && <span style={{ color: "var(--loki-accent)" }}>back · new since you moved on</span>}
                  {timesAround > 1 && <span style={{ color: "var(--loki-accent)" }}>{ordinal(timesAround)} time around · deferred {ago(priorSnooze!.at)} ago</span>}
                  {current.snooze && <span style={{ color: "var(--loki-muted)" }}>snoozed · due in {formatIn(current.snooze.until)}</span>}
                  {onPickMode && modeFor && (
                    <span style={{ position: "relative", display: "inline-flex" }}>
                      <ModeChip mode={isPermissionMode(thread?.mode) ? thread.mode : isPermissionMode(modeFor(current.agentId, current.id)) ? (modeFor(current.agentId, current.id) as PermissionMode) : null} busy={changingMode} onClick={() => setModeMenu((v) => !v)} />
                      <ModeMenu
                        open={modeMenu}
                        current={isPermissionMode(thread?.mode) ? thread.mode : isPermissionMode(modeFor(current.agentId, current.id)) ? (modeFor(current.agentId, current.id) as PermissionMode) : null}
                        onClose={() => setModeMenu(false)}
                        onPick={(m) => {
                          setModeMenu(false);
                          setChangingMode(true);
                          void onPickMode(current, m).finally(() => setChangingMode(false));
                        }}
                      />
                    </span>
                  )}
                  {onPickModel && modelFor && (
                    <span style={{ position: "relative", display: "inline-flex" }}>
                      <ModelChip
                        model={modelFor(current.agentId, current.id)}
                        busy={switching}
                        onClick={() => {
                          onLoadModels?.();
                          setModelPicker((v) => !v);
                        }}
                      />
                      <ModelPicker
                        open={modelPicker}
                        current={modelFor(current.agentId, current.id)}
                        entries={models}
                        loading={!models}
                        onClose={() => setModelPicker(false)}
                        onPick={(h) => {
                          setModelPicker(false);
                          setSwitching(true);
                          void onPickModel(current, h).finally(() => setSwitching(false));
                        }}
                      />
                    </span>
                  )}
                </div>
              </div>
              <span style={{ fontSize: 10.5, letterSpacing: "0.06em", color: badge?.color, border: `1px solid ${badge?.color}`, borderRadius: 999, padding: "3px 10px", whiteSpace: "nowrap" }}>
                {flash ?? badge?.label}
              </span>
            </div>

            <div ref={threadRef} style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: "16px 20px", fontSize: 13.5, lineHeight: 1.5, color: "var(--loki-fg)" }}>
              {!history && <div style={{ color: "var(--loki-muted)", fontSize: 12 }}>loading the thread…</div>}
              {history && history.length === 0 && <div style={{ color: "var(--loki-muted)", fontSize: 12 }}>no transcript on disk</div>}
              {history && <Transcript rows={history} streaming={thread?.status === "streaming"} />}
              {thread?.status === "thinking" && <div style={{ color: "var(--loki-muted)", fontSize: 12, padding: "6px 0" }}>thinking…</div>}
              {current.status === "failed" && current.error && (
                <div style={{ color: "var(--loki-negative)", fontFamily: "var(--loki-mono)", fontSize: 12, marginTop: 12 }}>{current.error}</div>
              )}
            </div>

            {current.status === "approval" && current.pendingApproval && <ApprovalCard approval={current.pendingApproval} />}
            {current.pendingQuestion && <QuestionCard question={current.pendingQuestion} onAnswer={(answers) => onAnswer(current, current.pendingQuestion!.requestId, answers)} />}

            <div style={{ display: "flex", gap: 8, padding: "12px 12px 8px", borderTop: "1px solid var(--loki-border)", alignItems: "flex-end" }}>
              <ChatInput
                ref={replyRef}
                value={draft}
                onChange={setDraft}
                onSubmit={sendReply}
                images={images}
                onImages={setImages}
                onEscape={() => (draft.trim() ? replyRef.current?.blur() : onClose())} // esc: keep a draft and hand keys back, or close an untouched deck
                onFocus={() => setTyping(true)}
                onBlur={() => setTyping(false)}
                placeholder={current.pendingApproval ? "reply, or approve / deny below…" : current.pendingQuestion ? (current.pendingQuestion.questions.length === 1 ? "answer in your own words, or pick above…" : "answer above…") : "reply… (enter to send · shift+enter new line)"}
              />
              <button onClick={sendReply} disabled={!draft.trim() && !images.length} style={{ ...btn("var(--loki-accent)"), opacity: draft.trim() || images.length ? 1 : 0.5 }}>send</button>
            </div>
            <div style={{ display: "flex", gap: 8, padding: "0 12px 12px", alignItems: "center", flexWrap: "wrap" }}>
              {current.pendingApproval && (
                <>
                  <button onClick={() => approve("allow")} style={btn("var(--loki-positive)")}>approve <kbd style={kbd}>{typing ? "⌘↵" : "A"}</kbd></button>
                  <button onClick={() => approve("deny")} style={btn("var(--loki-negative)")}>deny <kbd style={kbd}>{typing ? "⌘⇧D" : "D"}</kbd></button>
                </>
              )}
              <button onClick={() => { onOpenDesk(current.agentId, current.id); onClose(); }} style={btn()}>open desk <kbd style={kbd}>{typing ? "⌘O" : "O"}</kbd></button>
              <span style={{ flex: 1 }} />
              <button onClick={() => advance("unread")} style={btn()} title="not now — comes back later, later each time">← later <kbd style={kbd}>{typing ? "⌘[" : "←"}</kbd></button>
              <button onClick={() => advance("seen")} style={btn("var(--loki-fg)")}>next → <kbd style={kbd}>{typing ? "⌘]" : "→"}</kbd></button>
            </div>
          </div>
        )}
        <div style={{ textAlign: "center", marginTop: 12, fontSize: 10.5, color: "var(--loki-muted)", letterSpacing: "0.06em", fontFamily: "var(--loki-mono)" }}>
          {typing ? "enter send (you stay on the card) · ⌘] next · ⌘[ later · ⌘↵ approve · ⌘⇧D deny · ⌘O open · ⌘S snoozed · esc back to the deck's keys" : "→ next · ← later · A approve · D deny · R reply · O open · S snoozed · Z undo · esc close"}
        </div>
      </div>
    </div>
  );
}


