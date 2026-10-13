
import { Button, Row } from "../components";
import { ago } from "../shared/ago";
import { Head, ListPane, Pane } from "./bits";
import type { ReadingState } from "./useReading";
import type { MemoryCommit } from "../../../core/frame-types.ts";

/** Who made a commit, when it was a pass rather than the agent or you: Reflection, or the Doctor (/doctor). */
export const passAuthor = (author: string | null | undefined): string | null => (/reflection/i.test(author ?? "") ? "reflection" : /doctor/i.test(author ?? "") ? "doctor" : null);

/** The changes page: the memory's git log on the left, newest first; the picked commit's diff on the right, with Revert. */
export function ChangesPage({ log, shownSha, onPickSha, reading, onRevert }: { log: MemoryCommit[]; shownSha: string | null; onPickSha: (sha: string) => void; reading: ReadingState; onRevert: (sha: string) => void }) {
  return (
    <div style={{ minHeight: 0, display: "grid", gridTemplateColumns: "minmax(320px, 440px) 1fr" }}>
      <ListPane>
        <Head>Commits <span style={{ marginLeft: "auto", fontWeight: 400 }}>{log.length ? `last ${log.length}` : ""}</span></Head>
        {log.length === 0 && <div className="loki-meta loki-meta--wrap" style={{ padding: "0 8px" }}>no memory commits yet</div>}
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 2 }}>
          {log.map((c) => {
            const on = c.sha === shownSha;
            return (
              <Row dense key={c.sha} selected={on} onClick={() => onPickSha(c.sha)} style={{ display: "grid", gridTemplateColumns: "44px 1fr", gap: "2px 10px", alignItems: "baseline", fontSize: 13.5 }}>
                <span className="loki-meta loki-meta--wrap">{ago(c.at)}</span>
                <span style={{ lineHeight: 1.4 }}>
                  {c.message}
                  {passAuthor(c.author) && <span className="loki-meta loki-meta--wrap" style={{ marginLeft: 8 }}>{passAuthor(c.author)}</span>}
                </span>
                <span />
                <span className="loki-meta">{c.files.length === 0 ? "merge" : c.files.length === 1 ? c.files[0] : `${c.files.length} files`}</span>
              </Row>
            );
          })}
        </div>
      </ListPane>
      <Pane>
        <CommitView shownSha={shownSha} reading={reading} onRevert={onRevert} canRevert={log.find((c) => c.sha === shownSha)?.files.length !== 0} />
      </Pane>
    </div>
  );
}

/**
 * The picked commit: its short sha and Revert above, the diff below; a line when there is no commit or nothing to show.
 * Revert undoes the commit with a new one (it can be reverted in turn); a merge has no single change to undo.
 */
function CommitView({ shownSha, reading, onRevert, canRevert }: { shownSha: string | null; reading: ReadingState; onRevert: (sha: string) => void; canRevert: boolean }) {
  const { content, loadingView } = reading;
  if (!shownSha) return <div className="loki-meta loki-meta--wrap">nothing learned yet</div>;
  return (
    <>
      <div className="loki-label" style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <span style={{ color: "var(--loki-fg)" }}>Commit <span style={{ fontFamily: "var(--loki-mono)" }}>{shownSha.slice(0, 8)}</span></span>
        {loadingView && <span>Loading…</span>}
        <span style={{ flex: 1 }} />
        {canRevert && (
          <Button size="sm" tone="paper" onClick={() => onRevert(shownSha)} title="undo this change with a new commit">
            revert
          </Button>
        )}
      </div>
      {content === null && !loadingView && <div className="loki-meta loki-meta--wrap">nothing to show here</div>}
      {content !== null && <Diff text={content} />}
    </>
  );
}

/** A unified diff, coloured by line; the header lines (message, date, stat) stay muted. */
export function Diff({ text }: { text: string }) {
  return (
    <pre style={{ margin: 0, fontFamily: "var(--loki-mono)", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
      {text.split("\n").map((line, i) => {
        const color = line.startsWith("+") && !line.startsWith("+++") ? "var(--loki-positive)" : line.startsWith("-") && !line.startsWith("---") ? "var(--loki-negative)" : line.startsWith("@@") ? "var(--loki-accent)" : line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("+++") || line.startsWith("---") ? "var(--loki-muted)" : "var(--loki-fg)";
        return (
          <div key={i} style={{ color }}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}
