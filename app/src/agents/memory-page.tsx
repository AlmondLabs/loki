import { Button } from "../components";
import { ago } from "../shared/ago";
import type { ContentRow } from "../shell/content-list";
import { Pane, Prose } from "./bits";
import type { AgentDetails } from "./types";
import type { ReadingState } from "./use-reading";
import type { MemoryFile } from "../../../core/frame-types.ts";

export function memoryRows(files: readonly MemoryFile[]): ContentRow[] {
  return files
    .filter((f) => !f.path.startsWith("skills/") && f.path !== "profile.png")
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

export function MemoryPage({
  d,
  selected,
  filePath,
  reading,
  onAskToUpdate,
}: {
  d: AgentDetails;
  selected: string;
  filePath: string;
  reading: ReadingState;
  onAskToUpdate: (agentId: string, text: string) => void;
}) {
  const { content, loadingView } = reading;
  return (
    <Pane>
      <div className="loki-label flex items-center gap-2" style={{ marginBottom: 12 }}>
        <span className="loki-mono" style={{ color: "var(--loki-fg)" }}>
          {filePath}
        </span>
        {loadingView && <span>Loading…</span>}
        <span className="flex-1" />
        <Button
          size="sm"
          tone="paper"
          onClick={() => onAskToUpdate(selected, `In your memory file \`${filePath}\`, please update: `)}
          title="Opens the agent's main chat with the request started"
        >
          Ask {d.agent.name} to Update This
        </Button>
      </div>
      <Prose content={content} loadingView={loadingView} empty="Nothing to show here (binary, too large, or gone)" />
    </Pane>
  );
}
