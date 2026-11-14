import { Button } from "../components";
import { ago } from "../shared/ago";
import type { ContentRow } from "../shell/content-list";
import { Pane, Prose } from "./bits";
import type { AgentDetails } from "./types";
import type { ReadingState } from "./use-reading";
import type { MemoryFile } from "../../../core/frame-types.ts";

/**
 * The Memory page's items, the list's rows (plan 2026-11-14-1330, KTD9): the agent's memory files, flat, each under the
 * folder it sits in and named by the rest of its path, with when it last changed. The skills have their own page and
 * the face is the profile's, so both are left out. An outline of the folders is for later.
 */
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

/**
 * The Memory page's detail: the file chosen in the list, read. Memory is read-only here: to change a fact you hand the
 * request to the agent in its own chat.
 */
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
          tone="brass"
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
