import { Button } from "../components";
import { ago } from "../shared/ago";
import type { ContentRow } from "../shell/content-list";
import { Pane } from "./bits";
import type { ReadingState } from "./use-reading";
import type { MemoryCommit } from "../../../core/frame-types.ts";

export const passAuthor = (author: string | null | undefined): string | null =>
  /reflection/i.test(author ?? "") ? "reflection" : /doctor/i.test(author ?? "") ? "doctor" : null;

const filesSaid = (files: readonly string[]): string => (files.length === 0 ? "Merge" : files.length === 1 ? files[0] : `${files.length} files`);

export function changeRows(log: readonly MemoryCommit[]): ContentRow[] {
  return log.map((c) => {
    const pass = passAuthor(c.author);
    return {
      id: c.sha,
      title: c.message,
      preview: filesSaid(c.files),
      time: ago(c.at),
      flags: pass ? <span className="loki-meta">{pass}</span> : undefined,
    };
  });
}

export function ChangesPage({ commit, reading, onRevert }: { commit: MemoryCommit; reading: ReadingState; onRevert: (sha: string) => void }) {
  return (
    <Pane>
      <CommitView commit={commit} reading={reading} onRevert={onRevert} />
    </Pane>
  );
}

export function CommitView({ commit, reading, onRevert }: { commit: MemoryCommit; reading: ReadingState; onRevert: (sha: string) => void }) {
  const { content, loadingView } = reading;
  return (
    <>
      <div className="loki-label flex items-center gap-2" style={{ marginBottom: 12 }}>
        <span style={{ color: "var(--loki-fg)" }}>
          Commit <span className="loki-mono">{commit.sha.slice(0, 8)}</span>
        </span>
        {loadingView && <span>Loading…</span>}
        <span className="flex-1" />
        {commit.files.length > 0 && (
          <Button size="sm" tone="paper" onClick={() => onRevert(commit.sha)} title="Undo this change with a new commit">
            Revert
          </Button>
        )}
      </div>
      {content === null && !loadingView && <div className="loki-meta loki-meta--wrap">Nothing to show here</div>}
      {content !== null && <Diff text={content} />}
    </>
  );
}

export function Diff({ text }: { text: string }) {
  return (
    <pre
      className="loki-mono"
      style={{
        margin: 0,
        fontSize: "var(--text-xs)",
        lineHeight: 1.5,
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      }}
    >
      {text.split("\n").map((line, i) => {
        const color =
          line.startsWith("+") && !line.startsWith("+++")
            ? "var(--loki-positive)"
            : line.startsWith("-") && !line.startsWith("---")
              ? "var(--loki-negative)"
              : line.startsWith("@@")
                ? "var(--loki-accent)"
                : line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("+++") || line.startsWith("---")
                  ? "var(--loki-muted)"
                  : "var(--loki-fg)";
        return (
          <div key={i} style={{ color }}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}
