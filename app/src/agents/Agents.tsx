import { useState } from "react";
import type { Personality } from "../../../core/attention/protocol.ts";
import type { DeskSummary } from "../desk/useDesk";
import { AgentFace } from "../desk/AgentChip";
import { Button, Empty, NavButton, Title } from "../components";
import type { Task } from "../board/model";
import { AGENT_PAGES, AGENT_PAGE_HINT, AGENT_PAGE_KEY, DEFAULT_AGENT_PAGE, isAgentPage, type AgentPage } from "./pages";
import { firstAgentId, readingFor, shownShaOf, shownSkillOf } from "./reading";
import { useAgentDetails } from "./useAgentDetails";
import { useReading } from "./useReading";
import { NewAgent } from "./NewAgent";
import { ProfilePage } from "./ProfilePage";
import { MemoryPage } from "./MemoryPage";
import { ChangesPage } from "./ChangesPage";
import { SkillsPage, type Adding } from "./SkillsPage";
import type { AgentEdit, AgentsApi, AgentsWrite } from "./types";

export type { AgentDetails, AgentsApi, AgentsWrite } from "./types";
export { Diff } from "./ChangesPage";

/**
 * The Agents page: one tab per agent — its face, name, description and model (editable through the
 * app-server), its memory as a browsable tree with the git history of what it learned, its skills,
 * and where it is working (desks, tasks). Memory is read-only here: to change a fact you hand the
 * request to the agent in its own chat.
 */
export function Agents({
  agents,
  api,
  avatar,
  desks,
  tasks,
  initialAgentId,
  onOpenDesk,
  onAskToUpdate,
  onUpdateAgent,
  write,
  listModels,
  onShowDesks,
  onShowBoard,
}: {
  agents: Array<{ id: string; name: string }>;
  api: AgentsApi;
  avatar: (agentId: string) => string;
  desks: DeskSummary[];
  tasks: Task[] | null;
  initialAgentId: string | null;
  onOpenDesk: (agentId: string, conversationId: string) => void;
  /** Open the agent's main chat with a prefilled request to change a memory file. */
  onAskToUpdate: (agentId: string, text: string) => void;
  /** Through the app-server; resolves to an error message or null. */
  onUpdateAgent: (agentId: string, body: AgentEdit) => Promise<string | null>;
  write: AgentsWrite;
  listModels: () => Promise<Array<{ handle: string }>>;
  onShowDesks: () => void;
  onShowBoard: () => void;
}) {
  /** The tab the user picked; with nothing picked (the list not here yet, or the picked agent just deleted) the first agent shows. */
  const [picked, setPicked] = useState<string | null>(initialAgentId ?? firstAgentId(agents));
  const selected = picked ?? firstAgentId(agents);
  /** The page down the left, remembered for the window; and what each page has picked. */
  const [page, pick] = useAgentPage();
  const [filePath, setFilePath] = useState("system/persona.md");
  const [sha, setSha] = useState<string | null>(null);
  const [skillName, setSkillName] = useState<string | null>(null);
  /** Switch tabs: the memory, changes and skills pages start over for the new agent. */
  const setSelected = (id: string | null) => {
    if (id !== selected) {
      setFilePath("system/persona.md");
      setSha(null);
      setSkillName(null);
    }
    setPicked(id);
  };
  const [models, setModels] = useState<string[] | null>(null);
  const loadModels = () => void listModels().then((m) => setModels(m.map((e) => e.handle)));
  const [creating, setCreating] = useState(false);
  /** The skills page's add form (write here, or install from a source). */
  const [adding, setAdding] = useState<Adding>(null);

  const store = useAgentDetails({
    selected,
    api,
    write,
    onUpdateAgent,
    onAskToUpdate,
    onDeleted: () => setSelected(null),
    onSkillAdded: (name) => {
      setSkillName(name);
      pick("skills");
    },
  });
  const { d, log, notice, flash } = store;
  const shownSkill = shownSkillOf(d, skillName);
  const shownSha = shownShaOf(sha, log);
  const reading = useReading(selected, readingFor(page, filePath, shownSha, shownSkill), api);
  const created = async (opts: { personality: Personality; name: string; description?: string; model?: string }) => {
    const r = await write.createAgent(opts);
    if ("error" in r) return r.error;
    setCreating(false);
    setSelected(r.id);
    flash(`${opts.name} is here`);
    return null;
  };

  if (!agents.length && !creating) return <NoAgents onNew={() => setCreating(true)} />;

  const tabs = <AgentTabs agents={agents} selected={selected} creating={creating} avatar={avatar} notice={notice} onPick={setSelected} onNew={() => setCreating(true)} />;
  if (creating) {
    return (
      <Frame tabs={tabs}>
        <NewAgent models={models} onLoadModels={loadModels} onCreate={created} onCancel={() => setCreating(false)} canCancel={agents.length > 0} />
      </Frame>
    );
  }
  if (!selected) return <Frame tabs={tabs} />;
  if (d === undefined) {
    return (
      <Frame tabs={tabs}>
        <Centered>
          <Empty title="reading the agent…" />
        </Centered>
      </Frame>
    );
  }
  if (d === null) {
    return (
      <Frame tabs={tabs}>
        <Centered>
          <Empty title="No local record">
            <p>This agent has no local record on this machine (a remote or hidden agent).</p>
          </Empty>
        </Centered>
      </Frame>
    );
  }

  /** The four pages, by name; only the current one is mounted. */
  const pages: Record<AgentPage, React.ReactNode> = {
    profile: <ProfilePage d={d} selected={selected} avatar={avatar(selected)} models={models} onLoadModels={loadModels} onSave={store.save} desks={desks} tasks={tasks} onOpenDesk={onOpenDesk} onShowDesks={onShowDesks} onShowBoard={onShowBoard} confirmDelete={store.confirmDelete} setConfirmDelete={store.setConfirmDelete} onRemove={store.remove} />,
    memory: <MemoryPage d={d} selected={selected} filePath={filePath} onPickFile={setFilePath} reading={reading} onAskToUpdate={onAskToUpdate} />,
    changes: <ChangesPage log={log} shownSha={shownSha} onPickSha={setSha} reading={reading} />,
    skills: <SkillsPage d={d} store={store} viewSkill={shownSkill} onPickSkill={setSkillName} adding={adding} setAdding={setAdding} reading={reading} />,
  };
  return (
    <Frame tabs={tabs}>
      <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "150px 1fr" }}>
        {/* Pages down the left, the way Settings has them; the page is remembered for the window. */}
        <nav aria-label="agent pages" style={{ display: "grid", alignContent: "start", gap: 2, padding: "18px 12px 18px 20px", borderRight: "1px solid var(--loki-border)" }}>
          {AGENT_PAGES.map((p) => (
            <NavButton key={p} current={page === p} onClick={() => pick(p)}>
              {p}
            </NavButton>
          ))}
        </nav>

        <div style={{ minWidth: 0, minHeight: 0, display: "grid", gridTemplateRows: "auto minmax(0, 1fr)" }}>
          <div style={{ padding: "18px 28px 10px", display: "flex", alignItems: "baseline", gap: 12, borderBottom: "1px solid var(--loki-border)" }}>
            <Title page>{page}</Title>
            <span style={{ fontSize: 12, color: "var(--loki-muted)" }}>{AGENT_PAGE_HINT[page]}</span>
          </div>
          {pages[page]}
        </div>
      </div>
    </Frame>
  );
}

/** The page down the left, remembered for the window, like Settings' (sessionStorage). */
function useAgentPage(): [AgentPage, (p: AgentPage) => void] {
  const [page, setPageState] = useState<AgentPage>(() => {
    const saved = sessionStorage.getItem(AGENT_PAGE_KEY);
    return isAgentPage(saved) ? saved : DEFAULT_AGENT_PAGE;
  });
  const pick = (p: AgentPage) => {
    setPageState(p);
    sessionStorage.setItem(AGENT_PAGE_KEY, p);
  };
  return [page, pick];
}

/** Before the first agent: an invitation. */
function NoAgents({ onNew }: { onNew: () => void }) {
  return (
    <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
      <Empty title="No agents yet.">
        <p>An agent keeps its own memory, desks and skills here.</p>
        <div style={{ marginTop: 12 }}>
          <Button tone="brass" onClick={onNew}>new agent</Button>
        </div>
      </Empty>
    </div>
  );
}

/** The page's box: the tab strip above, the body below it. */
function Frame({ tabs, children }: { tabs: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", background: "var(--loki-bg)" }}>
      {tabs}
      {children}
    </div>
  );
}

/** A body that is one line in the middle: reading, or no record. */
function Centered({ children }: { children: React.ReactNode }) {
  return <div style={{ flex: 1, display: "grid", placeItems: "center" }}>{children}</div>;
}

/** The tab strip: one face per agent, "+ new" at the end, and the latest notice at the right. */
function AgentTabs({ agents, selected, creating, avatar, notice, onPick, onNew }: { agents: Array<{ id: string; name: string }>; selected: string | null; creating: boolean; avatar: (agentId: string) => string; notice: string | null; onPick: (id: string) => void; onNew: () => void }) {
  return (
    <div role="tablist" aria-label="agents" style={{ display: "flex", gap: 6, padding: "12px 24px 0", borderBottom: "1px solid var(--loki-border)" }}>
      {agents.map((a) => (
        <button
          key={a.id}
          role="tab"
          aria-selected={a.id === selected}
          onClick={() => onPick(a.id)}
          style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "8px 14px 10px", border: "none", borderBottom: `2px solid ${a.id === selected ? "var(--loki-accent)" : "transparent"}`, background: "transparent", color: a.id === selected ? "var(--loki-fg)" : "var(--loki-muted)", cursor: "pointer", font: "inherit", fontFamily: "var(--loki-font)", fontSize: 13.5 }}
        >
          <AgentFace name={a.name} src={avatar(a.id)} size={22} />
          {a.name}
        </button>
      ))}
      <button role="tab" aria-selected={creating} onClick={onNew} title="a new agent" style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 12px 10px", border: "none", borderBottom: `2px solid ${creating ? "var(--loki-accent)" : "transparent"}`, background: "transparent", color: creating ? "var(--loki-fg)" : "var(--loki-muted)", cursor: "pointer", font: "inherit", fontFamily: "var(--loki-font)", fontSize: 13.5 }}>
        + new
      </button>
      <span style={{ flex: 1 }} />
      {notice && <span style={{ alignSelf: "center", fontSize: 12, color: "var(--loki-accent)" }}>{notice}</span>}
    </div>
  );
}
