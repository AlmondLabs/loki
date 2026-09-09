import { useMemo } from "react";
import type { MemoryFile } from "../../../mod/agents.ts";
import { Button, Row } from "../ui";
import { ago } from "../board/model";
import { Head, ListPane, Pane, Prose } from "./bits";
import type { AgentDetails } from "./types";
import type { ReadingState } from "./useReading";

/**
 * The memory page: the files as a tree on the left (skills and the face left out), the picked one read
 * on the right. Memory is read-only here: to change a fact you hand the request to the agent in its own chat.
 */
export function MemoryPage({ d, selected, filePath, onPickFile, reading, onAskToUpdate }: { d: AgentDetails; selected: string; filePath: string; onPickFile: (path: string) => void; reading: ReadingState; onAskToUpdate: (agentId: string, text: string) => void }) {
  const { content, loadingView } = reading;
  return (
    <div style={{ minHeight: 0, display: "grid", gridTemplateColumns: "minmax(260px, 340px) 1fr" }}>
      <ListPane>
        <Head>files{d.lastCommit ? <span style={{ marginLeft: "auto", letterSpacing: 0, fontFamily: "var(--loki-mono)" }}>last change {ago(d.lastCommit.at)}</span> : null}</Head>
        <Tree files={d.files.filter((f) => !f.path.startsWith("skills/") && f.path !== "profile.png")} current={filePath} onPick={onPickFile} />
      </ListPane>
      <Pane>
        <div className="loki-label" style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 9.5, marginBottom: 12 }}>
          <span style={{ color: "var(--loki-fg)", letterSpacing: 0, fontFamily: "var(--loki-mono)", textTransform: "none" }}>{filePath}</span>
          {loadingView && <span>loading…</span>}
          <span style={{ flex: 1 }} />
          <Button size="sm" tone="brass" onClick={() => onAskToUpdate(selected, `In your memory file \`${filePath}\`, please update: `)} title="opens the agent's main chat with the request started">
            ask {d.agent.name} to update this
          </Button>
        </div>
        <Prose content={content} loadingView={loadingView} empty="nothing to show here (binary, too large, or gone)" />
      </Pane>
    </div>
  );
}

function Tree({ files, current, onPick }: { files: MemoryFile[]; current: string | null; onPick: (path: string) => void }) {
  // Group by the first folder; system first.
  const groups = useMemo(() => {
    const m = new Map<string, MemoryFile[]>();
    for (const f of files) {
      const g = f.path.includes("/") ? f.path.split("/")[0] : "";
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(f);
    }
    return [...m.entries()];
  }, [files]);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 8 }}>
      {groups.map(([g, fs]) => (
        <div key={g || "root"} style={{ minWidth: 0 }}>
          {g && <div className="loki-label" style={{ fontSize: 9.5, padding: "2px 8px" }}>{g}</div>}
          {fs.map((f) => (
            <Row dense key={f.path} selected={current === f.path} onClick={() => onPick(f.path)} title={`${f.bytes} bytes · ${ago(f.modifiedAt)}`} style={{ justifyContent: "space-between", gap: 8, fontSize: 12 }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g ? f.path.slice(g.length + 1) : f.path}</span>
              <span style={{ fontFamily: "var(--loki-mono)", fontSize: 10.5, color: "var(--loki-muted)", flex: "0 0 auto" }}>{ago(f.modifiedAt)}</span>
            </Row>
          ))}
        </div>
      ))}
    </div>
  );
}
