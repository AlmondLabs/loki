import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MARKDOWN_COMPONENTS } from "../chat/markdown-image";
import { Meta } from "../components";
import { stripFrontmatter } from "../shared/agent-model";

export function Pane({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-w-0" style={{ minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: "20px 20px 32px" }}>
      {children}
    </div>
  );
}

export function Prose({ content, loadingView, empty }: { content: string | null; loadingView: boolean; empty: string }) {
  return (
    <>
      {content === null && loadingView && <Meta>Loading…</Meta>}
      {content === null && !loadingView && <div className="loki-meta loki-meta--wrap">{empty}</div>}
      {content !== null && (
        <div className="loki-md" style={{ fontSize: "var(--text-sm)", lineHeight: 1.6, color: "var(--loki-fg)", maxWidth: 760, overflowWrap: "anywhere" }}>
          <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
            {stripFrontmatter(content)}
          </Markdown>
        </div>
      )}
    </>
  );
}
