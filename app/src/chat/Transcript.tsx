import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * One row of a conversation as loci shows it everywhere (desk chat, Catch Up):
 * user and assistant bubbles, quiet tool markers, collapsible harness events.
 */
export interface TranscriptRow {
  role: "user" | "assistant" | "tool" | "event";
  text: string;
  summary?: string | null;
  detail?: string | null;
}

export function Transcript({ rows, streaming = false, dim = true }: { rows: TranscriptRow[]; streaming?: boolean; dim?: boolean }) {
  return (
    <>
      {rows.map((m, i) => {
        const last = i === rows.length - 1;
        if (m.role === "tool") {
          return (
            <div key={i} data-row="tool" style={{ fontSize: 11, color: "var(--loci-muted)", fontFamily: "var(--loci-mono)", margin: "2px 0 2px 14px" }}>
              · {m.text}
            </div>
          );
        }
        if (m.role === "event") {
          return (
            <details key={i} data-row="event" style={{ margin: "8px 0", fontSize: 11.5, color: "var(--loci-muted)" }}>
              <summary style={{ cursor: m.detail ? "pointer" : "default", listStyle: m.detail ? "disclosure-closed" : "none", fontFamily: "var(--loci-mono)", letterSpacing: "0.04em" }}>
                ⟳ {m.text}
                {m.summary && <span style={{ color: "var(--loci-fg)", opacity: 0.75, marginLeft: 8, fontFamily: "var(--loci-font)", letterSpacing: 0 }}>{m.summary}</span>}
              </summary>
              {m.detail && (
                <pre style={{ margin: "6px 0 0 14px", padding: "8px 10px", background: "#101014", border: "1px solid var(--loci-border)", borderRadius: 6, fontSize: 11.5, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 220, overflow: "auto", color: "var(--loci-fg)" }}>
                  {m.detail}
                </pre>
              )}
            </details>
          );
        }
        return (
          <div key={i} data-row={m.role} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start", margin: "8px 0" }}>
            <div
              style={{
                maxWidth: "78%",
                padding: "9px 13px",
                borderRadius: 10,
                background: m.role === "user" ? "var(--loci-accent-soft)" : "#222228",
                opacity: !dim || last || m.role === "user" ? 1 : 0.85,
                color: "var(--loci-fg)",
              }}
            >
              {m.role === "assistant" ? (
                <div className="loci-md">
                  <Markdown remarkPlugins={[remarkGfm]}>{m.text}</Markdown>
                  {last && streaming && <span style={{ opacity: 0.6 }}>▍</span>}
                </div>
              ) : (
                <span style={{ whiteSpace: "pre-wrap" }}>{m.text}</span>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}
