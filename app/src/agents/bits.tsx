import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { stripFrontmatter } from "../phone/model";

/** A section's head, in the label voice; a right-aligned count or date goes in a span with marginLeft auto. */
export function Head({ children }: { children: React.ReactNode }) {
  return (
    <div className="loki-label" style={{ display: "flex", alignItems: "baseline", padding: "0 8px 6px" }}>
      {children}
    </div>
  );
}

/** The reading pane's shell: a scrolling column beside the list. */
export function Pane({ children }: { children: React.ReactNode }) {
  return <div style={{ minWidth: 0, minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: "14px 28px 24px" }}>{children}</div>;
}

/** The list beside the reading pane: a scrolling column with a rule down its right. */
export function ListPane({ children }: { children: React.ReactNode }) {
  return <div style={{ minWidth: 0, minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: "14px 16px 24px 28px", borderRight: "1px solid var(--loki-border)" }}>{children}</div>;
}

/** A memory file as prose: the frontmatter dropped, the markdown rendered; a line instead when there is nothing to show. */
export function Prose({ content, loadingView, empty }: { content: string | null; loadingView: boolean; empty: string }) {
  return (
    <>
      {content === null && !loadingView && <div style={{ fontSize: 12, color: "var(--loki-muted)" }}>{empty}</div>}
      {content !== null && (
        <div className="loki-md" style={{ fontSize: 13.5, lineHeight: 1.6, color: "var(--loki-fg)", maxWidth: 760, overflowWrap: "anywhere" }}>
          <Markdown remarkPlugins={[remarkGfm]}>{stripFrontmatter(content)}</Markdown>
        </div>
      )}
    </>
  );
}
