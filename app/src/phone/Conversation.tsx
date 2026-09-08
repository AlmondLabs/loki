import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Runtime } from "../../../packages/core/src/attention/protocol.ts";
import type { PendingApproval, PendingQuestion } from "../../../packages/core/src/attention/model.ts";
import { ApprovalCard } from "../chat/ApprovalCard";
import { QuestionCard } from "../chat/QuestionCard";
import { Transcript, type TranscriptRow } from "../chat/Transcript";
import { AgentChip, AgentFace } from "../desk/AgentChip";
import { avatarUrl } from "../desk/env";
import { Pin } from "./Home";
import { BackButton, SAFE, TopBar, tap } from "./ui";

/** The conversation a card opened; kept apart from the item so the screen survives the card clearing. */
export interface Thread {
  agentId: string;
  conversationId: string;
  title: string | null;
  agentName: string | null;
}

export interface ThreadView {
  rows: TranscriptRow[] | undefined;
  status: "idle" | "thinking" | "streaming";
  pending: PendingApproval | null;
  question: PendingQuestion | null;
  error: string | null;
}

/**
 * One conversation, full width: the transcript with the newest at the bottom, the approval or
 * question card inline where the desk chat puts it, and a reply box over the home indicator.
 * No images and no dictation here — the phone's keyboard does its own.
 */
export function Conversation({
  thread,
  view,
  waiting,
  banner,
  backLabel = "inbox",
  prefill = null,
  pinned = null,
  onPin,
  onBack,
  onLoad,
  onDecide,
  onAnswer,
  onSend,
  onSeen,
}: {
  thread: Thread;
  view: ThreadView;
  /** The card is still actionable: offer "seen" in the bar. */
  waiting: boolean;
  banner?: ReactNode;
  /** Where back goes, as a word. */
  backLabel?: string;
  /** Text the host wants in the reply box (an "ask the agent to…" from the agent's page); a new tick replaces the draft, as the desktop chat does. */
  prefill?: { text: string; tick: number } | null;
  /** The desk's pin state, when the mod knows this conversation as a desk; null hides the glyph. */
  pinned?: boolean | null;
  onPin?: (pinned: boolean) => void;
  onBack: () => void;
  onLoad: (rt: Runtime) => void;
  onDecide: (rt: Runtime, requestId: string, behavior: "allow" | "deny") => void;
  onAnswer: (rt: Runtime, requestId: string, answers: Record<string, string | string[]>) => void;
  onSend: (rt: Runtime, text: string, desk: string | null) => void;
  onSeen: (rt: Runtime) => void;
}) {
  const rt: Runtime = { agent_id: thread.agentId, conversation_id: thread.conversationId };
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    onLoad(rt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.agentId, thread.conversationId]);

  useEffect(() => {
    if (prefill && prefill.tick > 0) {
      setDraft(prefill.text);
      setTimeout(() => {
        const el = boxRef.current;
        el?.focus();
        el?.setSelectionRange(el.value.length, el.value.length);
      }, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.tick]);

  // Newest at the bottom, kept in view as rows stream in.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [view.rows?.length, view.status, view.pending?.requestId, view.question?.requestId]);

  // The box grows to about five lines, then scrolls.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 5 * 21 + 20)}px`;
  }, [draft]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    if (view.question && view.question.questions.length === 1) {
      onAnswer(rt, view.question.requestId, { [view.question.questions[0].question]: text }); // a typed reply is the answer
    } else onSend(rt, text, thread.title);
    setDraft("");
  };

  return (
    <>
      <TopBar
        left={<BackButton onClick={onBack} label={backLabel} />}
        title={thread.title ?? thread.conversationId}
        sub={
          <>
            <AgentFace name={thread.agentName} src={avatarUrl(thread.agentId)} size={14} />
            <AgentChip name={thread.agentName} size={9.5} />
            {view.status === "thinking" && <span>thinking…</span>}
            {view.status === "streaming" && <span>writing…</span>}
          </>
        }
        right={
          <>
            {waiting && !view.pending && (
              <button type="button" onClick={() => onSeen(rt)} style={{ ...tap("var(--loki-fg)"), minHeight: 34, padding: "4px 10px", fontSize: 12 }}>
                seen
              </button>
            )}
            {pinned !== null && onPin && (
              <button type="button" onClick={() => onPin(!pinned)} aria-label={pinned ? "unpin" : "pin"} aria-pressed={pinned} title={pinned ? "unpin" : "pin to the top"} style={{ width: 40, height: 40, display: "grid", placeItems: "center", border: "none", borderRadius: 8, background: "transparent", color: pinned ? "var(--loki-fg)" : "var(--loki-muted)", opacity: pinned ? 1 : 0.55, cursor: "pointer", padding: 0, WebkitTapHighlightColor: "transparent" }}>
                <Pin filled={pinned} />
              </button>
            )}
          </>
        }
      />
      {banner}
      <div ref={scrollRef} className="loki-phone-thread" style={{ flex: 1, minHeight: 0, overflowY: "auto", WebkitOverflowScrolling: "touch", padding: `12px calc(12px + ${SAFE.right}) 12px calc(12px + ${SAFE.left})`, fontSize: 13.5, lineHeight: 1.5, color: "var(--loki-fg)" }}>
        {!view.rows && <div style={{ color: "var(--loki-muted)", fontSize: 12 }}>loading the thread…</div>}
        {view.rows && view.rows.length === 0 && <div style={{ color: "var(--loki-muted)", fontSize: 12 }}>no transcript on disk</div>}
        {view.rows && <Transcript rows={view.rows} streaming={view.status === "streaming"} dim={false} />}
        {view.status === "thinking" && <div style={{ color: "var(--loki-muted)", fontSize: 12, padding: "6px 0" }}>thinking…</div>}
        {view.error && <div style={{ color: "var(--loki-negative)", fontFamily: "var(--loki-mono)", fontSize: 12, marginTop: 12, overflowWrap: "anywhere" }}>{view.error}</div>}
      </div>

      {view.pending && (
        <ApprovalCard
          approval={view.pending}
          actions={
            <>
              <button type="button" onClick={() => onDecide(rt, view.pending!.requestId, "allow")} style={tap("var(--loki-positive)")}>
                approve
              </button>
              <button type="button" onClick={() => onDecide(rt, view.pending!.requestId, "deny")} style={tap("var(--loki-negative)")}>
                deny
              </button>
            </>
          }
        />
      )}
      {view.question && <QuestionCard question={view.question} onAnswer={(answers) => onAnswer(rt, view.question!.requestId, answers)} />}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        style={{ flex: "0 0 auto", display: "flex", gap: 8, alignItems: "flex-end", padding: `10px calc(10px + ${SAFE.right}) calc(10px + ${SAFE.bottom}) calc(10px + ${SAFE.left})`, borderTop: "1px solid var(--loki-border)", background: "var(--loki-panel)" }}
      >
        <textarea
          ref={boxRef}
          value={draft}
          rows={1}
          name="message"
          autoComplete="off"
          autoCorrect="on"
          spellCheck
          enterKeyHint="send"
          data-1p-ignore
          data-form-type="other"
          placeholder={view.pending ? "reply, or approve / deny above…" : view.question ? (view.question.questions.length === 1 ? "answer in your own words, or pick above…" : "answer above…") : "reply…"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          style={{ flex: 1, minWidth: 0, resize: "none", overflowY: "auto", lineHeight: "21px", background: "var(--loki-well)", border: "1px solid var(--loki-border)", borderRadius: 8, padding: "9px 12px", fontSize: 15, fontFamily: "var(--loki-font)", color: "var(--loki-fg)", outline: "none" }}
        />
        <button type="submit" disabled={!draft.trim()} style={{ ...tap("var(--loki-accent)"), opacity: draft.trim() ? 1 : 0.5 }}>
          send
        </button>
      </form>
    </>
  );
}
