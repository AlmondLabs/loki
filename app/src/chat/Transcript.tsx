import { memo, useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { TranscriptRow } from "../../../core/attention/transcript.ts";
import { Button, IconButton } from "../components";

/** The row shape is core's (the phone renders the same rows); re-exported so chat code keeps one import. */
export type { TranscriptRow };

/**
 * Rows are memoised: parsing markdown for a long thread on every keystroke in
 * the message box made typing lag. A row re-renders only when its own text,
 * its last-ness, or the streaming cursor changes. The take-back handler reaches only queued rows,
 * and the host must keep its identity stable (ChatWindow does), or every row re-renders with it.
 */
export const Transcript = memo(function Transcript({ rows, streaming = false, dim = true, onCancelQueued }: { rows: TranscriptRow[]; streaming?: boolean; dim?: boolean; onCancelQueued?: (row: TranscriptRow) => void }) {
  return (
    <>
      {rows.map((m, i) => (
        <Row key={i} row={m} last={i === rows.length - 1} streaming={streaming} dim={dim} onCancelQueued={m.queued ? onCancelQueued : undefined} />
      ))}
    </>
  );
});

/** One row, by role. This is the memo boundary; the three shapes below are plain functions rendered inside it. */
const Row = memo(function Row({ row: m, last, streaming, dim, onCancelQueued }: { row: TranscriptRow; last: boolean; streaming: boolean; dim: boolean; onCancelQueued?: (row: TranscriptRow) => void }) {
  if (m.role === "tool") return <ToolRow row={m} />;
  if (m.role === "event") return <EventRow row={m} />;
  return <Bubble row={m} last={last} streaming={streaming} dim={dim} onCancelQueued={onCancelQueued} />;
});

function ToolRow({ row: m }: { row: TranscriptRow }) {
  return (
    <div data-row="tool" style={{ fontSize: 10.5, color: "var(--loki-muted)", fontFamily: "var(--loki-mono)", margin: "2px 0 2px 14px", overflowWrap: "anywhere" }}>
      · {m.text}
    </div>
  );
}

function EventRow({ row: m }: { row: TranscriptRow }) {
  return (
    <details data-row="event" style={{ margin: "8px 0", fontSize: 12, color: "var(--loki-muted)" }}>
      <summary style={{ cursor: m.detail ? "pointer" : "default", listStyle: m.detail ? "disclosure-closed" : "none", fontFamily: "var(--loki-mono)", letterSpacing: "0.06em" }}>
        ⟳ {m.text}
        {m.summary && <span style={{ color: "var(--loki-fg)", opacity: 0.75, marginLeft: 8, fontFamily: "var(--loki-font)", letterSpacing: 0 }}>{m.summary}</span>}
      </summary>
      {m.detail && (
        <pre style={{ margin: "6px 0 0 14px", padding: "8px 10px", background: "var(--loki-well)", border: "1px solid var(--loki-border)", borderRadius: 6, fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 220, overflow: "auto", color: "var(--loki-fg)" }}>
          {m.detail}
        </pre>
      )}
    </details>
  );
}

/** A user or assistant message: the bubble, and under a queued one the take-back button. */
function Bubble({ row: m, last, streaming, dim, onCancelQueued }: { row: TranscriptRow; last: boolean; streaming: boolean; dim: boolean; onCancelQueued?: (row: TranscriptRow) => void }) {
  return (
    <div data-row={m.role} data-queued={m.queued ? "true" : undefined} style={{ display: "flex", flexDirection: "column", alignItems: m.role === "user" ? "flex-end" : "flex-start", margin: "8px 0" }}>
      <div className="loki-bubble" data-role={m.role}>
      <div
        style={{
          maxWidth: "78%",
          minWidth: 0,
          overflowWrap: "anywhere",
          padding: "9px 13px",
          borderRadius: 12,
          background: m.role === "user" ? "var(--loki-accent-soft)" : "var(--loki-bubble)",
          // Typed mid-turn and not sent yet: quieter, with a dashed edge, until the turn ends.
          border: m.queued ? "1px dashed var(--loki-accent)" : undefined,
          opacity: m.queued ? 0.7 : !dim || last || m.role === "user" ? 1 : 0.85,
          color: "var(--loki-fg)",
        }}
      >
        {m.role === "assistant" ? <AssistantBody row={m} cursor={last && streaming} /> : <UserBody row={m} />}
      </div>
      {m.text && !(last && streaming) && <CopyMarkdown text={m.text} />}
      </div>
      {m.queued && (
        <Button bare size="sm" tone="brass" onClick={() => onCancelQueued?.(m)} disabled={!onCancelQueued} style={{ marginTop: 4 }}>
          queued · sends when this turn ends{onCancelQueued ? " · take back" : ""}
        </Button>
      )}
    </div>
  );
}

/** The bubble's text as it was written — markdown, not the rendering — onto the clipboard. Says "copied" for a beat. */
function CopyMarkdown({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // the clipboard refused (no permission in this context): the label stays, nothing else to say
    }
  };
  return (
    <IconButton size={24} className="loki-bubble-copy" label={copied ? "copied" : "copy as markdown"} data-copied={copied ? "true" : undefined} onClick={() => void copy()}>
      {copied ? (
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M3 8.5l3 3 7-7" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden>
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
          <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
        </svg>
      )}
    </IconButton>
  );
}

function AssistantBody({ row: m, cursor }: { row: TranscriptRow; cursor: boolean }) {
  return (
    <div className="loki-md">
      <Markdown remarkPlugins={[remarkGfm]}>{m.text}</Markdown>
      {cursor && <span style={{ opacity: 0.6 }}>▍</span>}
    </div>
  );
}

function UserBody({ row: m }: { row: TranscriptRow }) {
  return (
    <>
      {m.images && m.images.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: m.text ? 8 : 0 }}>
          {m.images.map((src, k) => (
            <img key={k} src={src} alt="" style={{ maxWidth: 220, maxHeight: 160, borderRadius: 6, border: "1px solid var(--loki-border)", display: "block" }} />
          ))}
        </div>
      )}
      {/* Your own words get the same markdown as the agent's: pasted prompts and skill text are full of it. */}
      {m.text && (
        <div className="loki-md">
          <Markdown remarkPlugins={[remarkGfm]}>{m.text}</Markdown>
        </div>
      )}
    </>
  );
}
