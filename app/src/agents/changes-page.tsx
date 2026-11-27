import { BrainIcon, HistoryIcon, WrenchIcon } from "lucide-react";
import type { MemoryCommit } from "../../../core/frame-types.ts";
import { Chip, Meta, sentence } from "../components";
import { ago } from "../shared/ago";
import type { ContentRow } from "../shell/content-list";
import type { FilterPill } from "../shell/filter-pills";
import { Pane } from "./bits";
import type { ReadingState } from "./use-reading";

export type ChangeFilter = "all" | "reflection" | "doctor";

export const passAuthor = (author: string | null | undefined): "reflection" | "doctor" | null =>
  /reflection/i.test(author ?? "") ? "reflection" : /doctor/i.test(author ?? "") ? "doctor" : null;

const filesSaid = (files: readonly string[]): string => (files.length === 0 ? "Merge" : files.length === 1 ? files[0] : `${files.length} files`);

export function filterChanges(log: readonly MemoryCommit[], filter: ChangeFilter, query = ""): MemoryCommit[] {
  const q = query.trim().toLowerCase();
  return log
    .filter((c) => filter === "all" || passAuthor(c.author) === filter)
    .filter(
      (c) =>
        !q ||
        c.message.toLowerCase().includes(q) ||
        c.sha.toLowerCase().includes(q) ||
        c.author.toLowerCase().includes(q) ||
        c.files.some((f) => f.toLowerCase().includes(q)),
    );
}

export function changePills(log: readonly MemoryCommit[], chosen: ChangeFilter): Array<FilterPill<ChangeFilter>> {
  const pills: Array<FilterPill<ChangeFilter>> = [{ value: "all", label: "All", icon: HistoryIcon }];
  if (chosen === "reflection" || log.some((c) => passAuthor(c.author) === "reflection")) {
    pills.push({ value: "reflection", label: "Reflection", icon: BrainIcon });
  }
  if (chosen === "doctor" || log.some((c) => passAuthor(c.author) === "doctor")) {
    pills.push({ value: "doctor", label: "Doctor", icon: WrenchIcon });
  }
  return pills;
}

export function changeRows(log: readonly MemoryCommit[]): ContentRow[] {
  return log.map((c) => {
    const pass = passAuthor(c.author);
    return {
      id: c.sha,
      title: c.message,
      preview: filesSaid(c.files),
      time: ago(c.at),
      flags: pass ? <span className="loki-meta">{sentence(pass)}</span> : undefined,
    };
  });
}

export function ChangesPage({ commit, reading }: { commit: MemoryCommit; reading: ReadingState }) {
  return (
    <Pane>
      <CommitView commit={commit} reading={reading} />
    </Pane>
  );
}

export function CommitView({ commit, reading }: { commit: MemoryCommit; reading: ReadingState }) {
  const { content, loadingView } = reading;
  const pass = passAuthor(commit.author);
  return (
    <div className="grid gap-4" style={{ maxWidth: 760 }}>
      <div className="grid gap-2">
        <div style={{ fontSize: "var(--text-base)", fontWeight: 600, color: "var(--loki-fg)", lineHeight: 1.4, overflowWrap: "anywhere" }}>
          {commit.message}
        </div>
        <div className="loki-meta loki-meta--wrap flex flex-wrap items-center gap-2">
          <span className="loki-mono">{commit.sha.slice(0, 8)}</span>
          {pass ? (
            <Chip static tag>
              {sentence(pass)}
            </Chip>
          ) : (
            commit.author && <span>· {commit.author}</span>
          )}
          <span title={new Date(commit.at).toLocaleString()}>· {ago(commit.at)}</span>
          <span>· {filesSaid(commit.files)}</span>
          {loadingView && <span>· Loading…</span>}
        </div>
      </div>
      {content === null && !loadingView && <Meta wrap>Nothing to show here</Meta>}
      {content !== null && (
        <div
          style={{
            background: "var(--loki-panel)",
            border: "1px solid var(--loki-border)",
            borderRadius: "var(--radius-xl)",
            padding: 16,
            overflowX: "auto",
          }}
        >
          <Diff text={content} />
        </div>
      )}
    </div>
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
