import type { MemoryCommit } from "../../../mod/agents.ts";
import { Row } from "../components";
import { ago } from "../board/model";
import { Head, ListPane, Pane } from "./bits";
import type { ReadingState } from "./useReading";

/** The changes page: the memory's git log on the left, newest first; the picked commit's diff on the right. */
export function ChangesPage({ log, shownSha, onPickSha, reading }: { log: MemoryCommit[]; shownSha: string | null; onPickSha: (sha: string) => void; reading: ReadingState }) {
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
                  {/reflection/i.test(c.author ?? "") && <span className="loki-meta loki-meta--wrap" style={{ marginLeft: 8 }}>reflection</span>}
                </span>
                <span />
                <span className="loki-meta">{c.files.length === 0 ? "merge" : c.files.length === 1 ? c.files[0] : `${c.files.length} files`}</span>
              </Row>
            );
          })}
        </div>
      </ListPane>
      <Pane>
        <CommitView shownSha={shownSha} reading={reading} />
      </Pane>
    </div>
  );
}

/** The picked commit: its short sha above, the diff below; a line when there is no commit or nothing to show. */
function CommitView({ shownSha, reading }: { shownSha: string | null; reading: ReadingState }) {
  const { content, loadingView } = reading;
  if (!shownSha) return <div className="loki-meta loki-meta--wrap">nothing learned yet</div>;
  return (
    <>
      <div className="loki-label" style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <span style={{ color: "var(--loki-fg)" }}>Commit <span style={{ fontFamily: "var(--loki-mono)" }}>{shownSha.slice(0, 8)}</span></span>
        {loadingView && <span>Loading…</span>}
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
