import { memo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * One row of a conversation as loki shows it everywhere (desk chat, Catch Up):
 * user and assistant bubbles, quiet tool markers, collapsible harness events.
 */
export interface TranscriptRow {
  role: "user" | "assistant" | "tool" | "event";
  text: string;
  summary?: string | null;
  detail?: string | null;
  /** Data URLs of images sent with a user message (live rows only; history shows a marker). */
  images?: string[];
}

/**
 * Rows are memoised: parsing markdown for a long thread on every keystroke in
 * the message box made typing lag. A row re-renders only when its own text,
 * its last-ness, or the streaming cursor changes.
 */
export const Transcript = memo(function Transcript({ rows, streaming = false, dim = true }: { rows: TranscriptRow[]; streaming?: boolean; dim?: boolean }) {
  return (
    <>
      {rows.map((m, i) => (
        <Row key={i} row={m} last={i === rows.length - 1} streaming={streaming} dim={dim} />
      ))}
    </>
  );
});

const Row = memo(function Row({ row: m, last, streaming, dim }: { row: TranscriptRow; last: boolean; streaming: boolean; dim: boolean }) {
  if (m.role === "tool") {
    return (
      <div data-row="tool" style={{ fontSize: 10.5, color: "var(--loki-muted)", fontFamily: "var(--loki-mono)", margin: "2px 0 2px 14px", overflowWrap: "anywhere" }}>
        · {m.text}
      </div>
    );
  }
  if (m.role === "event") {
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
  return (
    <div data-row={m.role} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start", margin: "8px 0" }}>
      <div
        style={{
          maxWidth: "78%",
          minWidth: 0,
          overflowWrap: "anywhere",
          padding: "9px 13px",
          borderRadius: 12,
          background: m.role === "user" ? "var(--loki-accent-soft)" : "var(--loki-bubble)",
          opacity: !dim || last || m.role === "user" ? 1 : 0.85,
          color: "var(--loki-fg)",
        }}
      >
        {m.role === "assistant" ? (
          <div className="loki-md">
            <Markdown remarkPlugins={[remarkGfm]}>{m.text}</Markdown>
            {last && streaming && <span style={{ opacity: 0.6 }}>▍</span>}
          </div>
        ) : (
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
        )}
      </div>
    </div>
  );
});
