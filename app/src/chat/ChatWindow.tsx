import { useEffect, useRef, useState } from "react";
import "./chat.css";
import { ChatInput } from "./ChatInput";
import type { PendingApproval } from "../attention/model";
import { ApprovalCard } from "./ApprovalCard";
import { Transcript, type TranscriptRow } from "./Transcript";
import { btn } from "./ui";
import { AgentChip } from "../desk/AgentChip";

export type ChatMessage = TranscriptRow;
export type ChatStatus = "idle" | "thinking" | "streaming";

/** Full-height panel: docked to the right edge, or centred and wider. */
export const CHAT_PANEL_WIDTH = 400;
export const CHAT_CENTER_WIDTH = 760;
export type ChatLayout = "right" | "center";

export function ChatWindow({
  messages,
  status,
  error,
  title,
  agentName,
  layout = "right",
  onToggleLayout,
  approval = null,
  onApprove,
  onSend,
  onClose,
}: {
  messages: ChatMessage[];
  status: ChatStatus;
  error: string | null;
  /** Desk / conversation title for the header. */
  title?: string | null;
  /** The agent on the other side. */
  agentName?: string | null;
  layout?: ChatLayout;
  onToggleLayout?: () => void;
  /** The conversation is paused on a tool permission; the panel shows it inline. */
  approval?: PendingApproval | null;
  onApprove?: (behavior: "allow" | "deny") => void;
  onSend: (text: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // The panel is see-through unless you are using it: hovered, focused, or a reply is arriving.
  const [hover, setHover] = useState(false);
  const [focused, setFocused] = useState(false);
  const [recent, setRecent] = useState(false);
  useEffect(() => {
    setRecent(true);
    const t = setTimeout(() => setRecent(false), 2500);
    return () => clearTimeout(t);
  }, [messages.length, status]);
  const attentive = hover || focused || recent || status !== "idle" || !!approval;

  // Follow the bottom only while the reader is there. Scrolling up to read
  // older messages must survive streaming deltas; sending a message re-pins.
  const pinnedRef = useRef(true);
  const [unpinned, setUnpinned] = useState(false);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    pinnedRef.current = pinned;
    setUnpinned(!pinned);
  };
  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = true;
    setUnpinned(false);
    el.scrollTo({ top: el.scrollHeight });
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const last = messages[messages.length - 1];
    if (pinnedRef.current || last?.role === "user") {
      pinnedRef.current = true;
      setUnpinned(false);
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, status]);

  const submit = () => {
    const text = draft.trim();
    if (!text || status !== "idle") return;
    setDraft("");
    onSend(text);
  };

  return (
    <div
      onPointerDown={(e) => e.stopPropagation()}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
      data-attentive={attentive ? "true" : "false"}
      style={{
        position: "absolute",
        ...(layout === "center"
          ? { top: 24, bottom: 24, left: "50%", transform: "translateX(-50%)", width: CHAT_CENTER_WIDTH, maxWidth: "calc(100vw - 48px)", border: "1px solid var(--loci-border, #2c2c34)", borderRadius: 14 }
          : { top: 0, right: 0, bottom: 0, width: CHAT_PANEL_WIDTH, maxWidth: "100vw", borderLeft: "1px solid var(--loci-border, #2c2c34)" }),
        display: "flex",
        flexDirection: "column",
        background: "var(--loci-panel, #1a1a20)",
        boxShadow: attentive ? (layout === "center" ? "0 24px 80px rgba(0,0,0,0.55)" : "-12px 0 40px rgba(0,0,0,0.45)") : "none",
        overflow: "hidden",
        zIndex: 100000,
        opacity: attentive ? 1 : 0.12,
        transition: "opacity 220ms ease-out, box-shadow 220ms ease-out, width 200ms ease-out",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 10,
          padding: "12px 16px",
          borderBottom: "1px solid var(--loci-border, #2c2c34)",
        }}
      >
        <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
          <span className="loci-label" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            chat {agentName && <AgentChip name={agentName} />}
          </span>
          {title && (
            <span style={{ fontFamily: "var(--loci-display)", fontSize: 14, color: "var(--loci-fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
          )}
        </span>
        <span style={{ display: "flex", gap: 2, alignItems: "center" }}>
          {onToggleLayout && (
            <button
              onClick={onToggleLayout}
              aria-label={layout === "center" ? "pin chat to the right" : "centre chat"}
              title={layout === "center" ? "pin to the right" : "centre, wider"}
              style={{ border: "none", background: "transparent", color: "var(--loci-muted)", cursor: "pointer", display: "grid", placeItems: "center", width: 24, height: 24, borderRadius: 6 }}
            >
              {layout === "center" ? (
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><path d="M9.5 2.5v11" /></svg>
              ) : (
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><rect x="4.5" y="5" width="7" height="6" rx="1" /></svg>
              )}
            </button>
          )}
        <button
          onClick={onClose}
          aria-label="close chat"
          style={{
            border: "none",
            background: "transparent",
            color: "var(--loci-muted)",
            cursor: "pointer",
            fontSize: 14,
          }}
        >
          ×
        </button>
        </span>
      </div>

      <div ref={scrollRef} onScroll={onScroll} style={{ flex: 1, overflowY: "auto", padding: "12px 16px", position: "relative", fontSize: 13.5, lineHeight: 1.5, color: "var(--loci-fg)" }}>
        {messages.length === 0 && (
          <div style={{ color: "var(--loci-muted)", fontSize: 12, padding: 8 }}>
            same conversation, different room — everything here lands in {agentName ? `${agentName}'s` : "the"} transcript
          </div>
        )}
        <Transcript rows={messages} streaming={status === "streaming"} />
        {status === "thinking" && !approval && (
          <div style={{ color: "var(--loci-muted)", fontSize: 12, padding: "6px 8px" }}>
            thinking…
          </div>
        )}
        {error && (
          <div style={{ color: "var(--loci-negative)", fontFamily: "var(--loci-mono)", fontSize: 12, padding: "6px 8px" }}>{error}</div>
        )}
      </div>
      {approval && (
        <ApprovalCard
          approval={approval}
          actions={
            onApprove && (
              <>
                <button onClick={() => onApprove("allow")} style={btn("var(--loci-positive)")}>approve</button>
                <button onClick={() => onApprove("deny")} style={btn("var(--loci-negative)")}>deny</button>
              </>
            )
          }
        />
      )}
      {unpinned && (
        <button
          onClick={jumpToLatest}
          aria-label="jump to latest"
          style={{ position: "absolute", bottom: 84, left: "50%", transform: "translateX(-50%)", padding: "4px 10px", borderRadius: 999, border: "1px solid var(--loci-border, #2c2c34)", background: "var(--loci-panel, #1a1a20)", color: "var(--loci-muted)", fontSize: 11, fontFamily: "var(--loci-mono)", cursor: "pointer", boxShadow: "0 6px 20px rgba(0,0,0,0.4)" }}
        >
          ↓ latest
        </button>
      )}

      <div style={{ display: "flex", gap: 8, padding: 12, borderTop: "1px solid var(--loci-border)", alignItems: "flex-end" }}>
        <ChatInput
          value={draft}
          onChange={setDraft}
          onSubmit={submit}
          placeholder={status === "idle" ? `message ${agentName ?? "the agent"}… (shift+enter for a new line)` : "waiting…"}
        />
        <button
          onClick={submit}
          disabled={status !== "idle" || !draft.trim()}
          style={{ ...btn(status === "idle" && draft.trim() ? "var(--loci-accent)" : "var(--loci-muted)"), cursor: status === "idle" ? "pointer" : "default", opacity: status === "idle" && draft.trim() ? 1 : 0.6 }}
        >
          send
        </button>
      </div>
    </div>
  );
}

export function ChatBubble({ open, onToggle, alert = false }: { open: boolean; onToggle: () => void; alert?: boolean }) {
  return (
    <button
      data-alert={alert || undefined}
      onClick={onToggle}
      onPointerDown={(e) => e.stopPropagation()}
      aria-label="toggle chat"
      style={{
        position: "absolute",
        right: 20,
        bottom: 20,
        width: 48,
        height: 48,
        borderRadius: 24,
        border: "1px solid var(--loci-border, #2c2c34)",
        background: open ? "#3b5bdb" : "var(--loci-panel, #1a1a20)",
        color: "var(--loci-fg)",
        fontSize: 18,
        cursor: "pointer",
        boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
        zIndex: 100001,
      }}
    >
      {open ? "×" : "✳"}
      {alert && !open && (
        <span
          aria-label="permission waiting"
          style={{ position: "absolute", top: -2, right: -2, width: 12, height: 12, borderRadius: 6, background: "#e6b450", border: "2px solid var(--loci-bg, #101014)" }}
        />
      )}
    </button>
  );
}
