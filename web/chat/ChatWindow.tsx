import { useEffect, useRef, useState } from "react";

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}
export type ChatStatus = "idle" | "thinking" | "streaming";

export function ChatWindow({
  messages,
  status,
  error,
  onSend,
  onClose,
}: {
  messages: ChatMessage[];
  status: ChatStatus;
  error: string | null;
  onSend: (text: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
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
      style={{
        position: "absolute",
        right: 20,
        bottom: 84,
        width: 340,
        height: 440,
        display: "flex",
        flexDirection: "column",
        background: "var(--loci-panel, #1a1a20)",
        border: "1px solid var(--loci-border, #2c2c34)",
        borderRadius: 12,
        boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
        overflow: "hidden",
        zIndex: 100000,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "10px 14px",
          borderBottom: "1px solid var(--loci-border, #2c2c34)",
        }}
      >
        <span style={{ fontSize: 12, letterSpacing: "0.08em", color: "var(--loci-fg)" }}>
          ira · canvas chat
        </span>
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
      </div>

      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 12 }}>
        {messages.length === 0 && (
          <div style={{ color: "var(--loci-muted)", fontSize: 12, padding: 8 }}>
            same conversation, different room — everything here lands in your main transcript
          </div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              margin: "6px 0",
              display: "flex",
              justifyContent: m.role === "user" ? "flex-end" : "flex-start",
            }}
          >
            <div
              style={{
                maxWidth: "85%",
                padding: "8px 10px",
                borderRadius: 10,
                fontSize: 13,
                lineHeight: 1.45,
                whiteSpace: "pre-wrap",
                background: m.role === "user" ? "#2b3a55" : "#222228",
                color: "var(--loci-fg)",
              }}
            >
              {m.text}
              {m.role === "assistant" && i === messages.length - 1 && status === "streaming" && (
                <span style={{ opacity: 0.6 }}>▍</span>
              )}
            </div>
          </div>
        ))}
        {status === "thinking" && (
          <div style={{ color: "var(--loci-muted)", fontSize: 12, padding: "6px 8px" }}>
            thinking…
          </div>
        )}
        {error && (
          <div style={{ color: "#e07878", fontSize: 12, padding: "6px 8px" }}>{error}</div>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, padding: 10, borderTop: "1px solid var(--loci-border, #2c2c34)" }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder={status === "idle" ? "message ira…" : "waiting…"}
          style={{
            flex: 1,
            background: "#101014",
            border: "1px solid var(--loci-border, #2c2c34)",
            borderRadius: 8,
            padding: "8px 10px",
            fontSize: 13,
            color: "var(--loci-fg)",
            outline: "none",
          }}
        />
        <button
          onClick={submit}
          disabled={status !== "idle" || !draft.trim()}
          style={{
            border: "none",
            borderRadius: 8,
            padding: "8px 12px",
            fontSize: 13,
            cursor: status === "idle" ? "pointer" : "default",
            background: status === "idle" && draft.trim() ? "#3b5bdb" : "#2a2a32",
            color: "var(--loci-fg)",
          }}
        >
          send
        </button>
      </div>
    </div>
  );
}

export function ChatBubble({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
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
    </button>
  );
}
