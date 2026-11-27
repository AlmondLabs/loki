import type { MemoryFile } from "../../../core/frame-types.ts";
import { ago } from "../shared/ago";
import type { ContentRow } from "../shell/content-list";
import { Pane, Prose } from "./bits";
import type { AgentDetails } from "./types";
import type { ReadingState } from "./use-reading";

export function memoryRows(files: readonly MemoryFile[], query = ""): ContentRow[] {
  const q = query.trim().toLowerCase();
  return files
    .filter((f) => !f.path.startsWith("skills/") && f.path !== "profile.png")
    .filter((f) => !q || f.path.toLowerCase().includes(q))
    .map((f) => {
      const folder = f.path.includes("/") ? f.path.split("/")[0] : undefined;
      return {
        id: f.path,
        title: folder ? f.path.slice(folder.length + 1) : f.path,
        time: ago(f.modified_at),
        label: `${f.path}, ${f.bytes} bytes`,
        section: folder,
      };
    });
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 ? `${Math.round((bytes / 1024) * 10) / 10} KB` : `${bytes} B`;
}

export function MemoryPage({ d, filePath, reading }: { d: AgentDetails; filePath: string; reading: ReadingState }) {
  const { content, loadingView } = reading;
  const file = d.files.find((f) => f.path === filePath);
  const title = filePath.split("/").pop() ?? filePath;
  return (
    <Pane>
      <div className="grid gap-1" style={{ maxWidth: 760, marginBottom: 16 }}>
        <div style={{ fontSize: "var(--text-base)", fontWeight: 600, color: "var(--loki-fg)", overflowWrap: "anywhere" }}>{title}</div>
        <div className="loki-meta loki-meta--wrap flex flex-wrap items-center gap-2">
          <span className="loki-mono">{filePath}</span>
          {file && <span>· {ago(file.modified_at)}</span>}
          {file && <span>· {formatBytes(file.bytes)}</span>}
          {loadingView && <span>· Loading…</span>}
        </div>
      </div>
      <Prose content={content} loadingView={loadingView} empty="Nothing to show here (binary, too large, or gone)" />
    </Pane>
  );
}
