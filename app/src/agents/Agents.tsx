import { useEffect, useState } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import type { Personality } from "../../../core/attention/protocol.ts";
import type { DeskSummary } from "../desk/useDesk";
import { AgentFace } from "../desk/AgentChip";
import { registerActions } from "../shell/keymap";
import { Button, EmptyPane, PaneHeader, type Tab } from "../components";
import { Icon } from "../shared/icons";
import { COLUMN_DEFAULT } from "../shell/column";
import type { Task } from "../board/model";
import { AGENT_PAGES, AGENT_PAGE_HINT, AGENT_PAGE_LABEL, type AgentPage } from "./pages";
import { readingFor, shownShaOf, shownSkillOf } from "./reading";
import { agentsSelection, shownAgent, useAgentsSelection, type AgentsSelection } from "./selection";
import { AgentsColumn } from "./AgentsColumn";
import { useAgentDetails } from "./useAgentDetails";
import { useReading } from "./useReading";
import { NewAgent } from "./NewAgent";
import { ProfilePage } from "./ProfilePage";
import { MemoryPage } from "./MemoryPage";
import { ChangesPage } from "./ChangesPage";
import { ReflectionPage } from "./ReflectionPage";
import { SkillsPage, type Adding } from "./SkillsPage";
import type { AgentEdit, AgentsApi, AgentsWrite, ReflectionControls } from "./types";

export type { AgentDetails, AgentsApi, AgentsWrite } from "./types";
export { Diff } from "./ChangesPage";
export { AgentsColumn } from "./AgentsColumn";

/**
 * The Agents page, Slack's DMs (plan 013 U10): the agents down the column (AgentsColumn), the chosen one
 * in the pane under a header whose tabs are its pages — its face, name, description and model (editable
 * through the app-server), its memory as a browsable tree with the git history of what it learned, its skills,
 * and where it is working (desks, tasks). Memory is read-only here: to change a fact you hand the
 * request to the agent in its own chat.
 */
export function Agents({
  agents,
  api,
  avatar,
  desks,
  items = NO_ITEMS,
  tasks,
  initialAgentId,
  onOpenDesk,
  onAskToUpdate,
  onUpdateAgent,
  write,
  reflect,
  listModels,
  onShowDesks,
  onShowBoard,
  columnOutside = false,
  selection = agentsSelection,
}: {
  agents: Array<{ id: string; name: string }>;
  api: AgentsApi;
  avatar: (agentId: string) => string;
  desks: DeskSummary[];
  /** The Inbox's items: the column's live state and waiting badges (only read when the column is inside). */
  items?: AttentionItem[];
  tasks: Task[] | null;
  initialAgentId: string | null;
  onOpenDesk: (agentId: string, conversationId: string) => void;
  /** Open the agent's main chat with a prefilled request to change a memory file. */
  onAskToUpdate: (agentId: string, text: string) => void;
  /** Through the app-server; resolves to an error message or null. */
  onUpdateAgent: (agentId: string, body: AgentEdit) => Promise<string | null>;
  write: AgentsWrite;
  /** Letta's reflection settings and a pass by hand, through the app-server. */
  reflect: ReflectionControls;
  listModels: () => Promise<Array<{ handle: string }>>;
  onShowDesks: () => void;
  onShowBoard: () => void;
  /** The Shell's list column holds AgentsColumn (plan 013 U10): draw only the pane. Otherwise the column sits inside, at the left. */
  columnOutside?: boolean;
  /** The chosen agent, page and new-agent form, shared with AgentsColumn; the window's one by default. */
  selection?: AgentsSelection;
}) {
  const sel = useAgentsSelection(selection);
  /** The agent the column picked; with nothing picked the desk's agent, and after a delete the first agent. */
  const selected = shownAgent(sel.agent, initialAgentId, agents);
  const { page, creating } = sel;
  const pick = selection.pickPage;
  const setSelected = selection.pickAgent;
  const setCreating = selection.setCreating;
  /** What each page has picked; the memory, changes and skills pages start over for another agent. */
  const [filePath, setFilePath] = useState("system/persona.md");
  const [sha, setSha] = useState<string | null>(null);
  const [skillName, setSkillName] = useState<string | null>(null);
  const [pickedFor, setPickedFor] = useState(selected);
  if (pickedFor !== selected) {
    // state derived from the selection, reset during render (the React pattern), so the new agent's first paint is clean
    setPickedFor(selected);
    setFilePath("system/persona.md");
    setSha(null);
    setSkillName(null);
  }
  const [models, setModels] = useState<string[] | null>(null);
  const loadModels = () => void listModels().then((m) => setModels([...new Set(m.map((e) => e.handle))]));
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
    setSelected(r.id); // closes the form too
    flash(`${opts.name} is here`);
    return null;
  };

  // ⌘[ and ⌘] step through the agents (agents.prev / agents.next in the keymap), wrapping at the ends.
  useEffect(() => {
    const step = (d: 1 | -1) => {
      if (agents.length < 2) return;
      const i = Math.max(0, agents.findIndex((a) => a.id === selected));
      setSelected(agents[(i + d + agents.length) % agents.length].id);
    };
    return registerActions({ "agents.prev": () => step(-1), "agents.next": () => step(1) });
  });

  const frame = (pane: React.ReactNode) => (columnOutside ? <Frame>{pane}</Frame> : <Frame column={<AgentsColumn agents={agents} desks={desks} items={items} avatar={avatar} initialAgentId={initialAgentId} selection={selection} />}>{pane}</Frame>);

  if (!agents.length && !creating) return frame(<NoAgents onNew={() => setCreating(true)} />);
  if (creating) {
    return frame(
      <>
        <PaneHeader title="New agent" lead={<Icon name="plus" size={20} />} aside={notice} />
        <NewAgent models={models} onLoadModels={loadModels} onCreate={created} onCancel={() => setCreating(false)} canCancel={agents.length > 0} />
      </>,
    );
  }
  if (!selected) return frame(null);
  const name = d?.agent.name ?? agents.find((a) => a.id === selected)?.name ?? "agent";
  const header = (tabs: boolean) => (
    <PaneHeader
      title={name}
      lead={<AgentFace name={name} src={avatar(selected)} size={24} />}
      aside={notice ?? (tabs ? AGENT_PAGE_HINT[page] : undefined)}
      tabs={tabs ? PAGE_TABS : undefined}
      tab={page}
      onTab={pick}
      tabsLabel="Agent pages"
      panelId={(p) => `loki-agent-page-${p}`}
    />
  );
  if (d === undefined) {
    return frame(
      <>
        {header(false)}
        <EmptyPane title="reading the agent…" />
      </>,
    );
  }
  if (d === null) {
    return frame(
      <>
        {header(false)}
        <EmptyPane title="No local record">
          <p>This agent has no local record on this machine (a remote or hidden agent).</p>
        </EmptyPane>
      </>,
    );
  }

  /** The five pages, by name; only the current one is mounted. */
  const pages: Record<AgentPage, React.ReactNode> = {
    profile: <ProfilePage d={d} selected={selected} avatar={avatar(selected)} models={models} onLoadModels={loadModels} onSave={store.save} desks={desks} tasks={tasks} onOpenDesk={onOpenDesk} onShowDesks={onShowDesks} onShowBoard={onShowBoard} confirmDelete={store.confirmDelete} setConfirmDelete={store.setConfirmDelete} onRemove={store.remove} />,
    memory: <MemoryPage d={d} selected={selected} filePath={filePath} onPickFile={setFilePath} reading={reading} onAskToUpdate={onAskToUpdate} />,
    changes: <ChangesPage log={log} shownSha={shownSha} onPickSha={setSha} reading={reading} />,
    reflection: <ReflectionPage key={selected} agentId={selected} agentName={d.agent.name} desks={desks} api={api} reflect={reflect} onOpenDesk={onOpenDesk} />,
    skills: <SkillsPage d={d} store={store} viewSkill={shownSkill} onPickSkill={setSkillName} adding={adding} setAdding={setAdding} reading={reading} />,
  };
  return frame(
    <>
      {header(true)}
      {/* The page under the agent's header and tab row, Slack's Messages | Canvas | Files; the page is remembered for the window. */}
      <div id={`loki-agent-page-${page}`} role="tabpanel" aria-label={page} style={{ flex: 1, minWidth: 0, minHeight: 0, display: "grid", gridTemplateRows: "minmax(0, 1fr)" }}>
        {pages[page]}
      </div>
    </>,
  );
}

const NO_ITEMS: AttentionItem[] = [];

/** The pages as the header's tabs. */
const PAGE_TABS: readonly Tab<AgentPage>[] = AGENT_PAGES.map((p) => ({ id: p, label: AGENT_PAGE_LABEL[p] }));

/** Before the first agent: an invitation, as the pane's empty state. */
function NoAgents({ onNew }: { onNew: () => void }) {
  return (
    <EmptyPane title="No agents yet.">
      <p>An agent keeps its own memory, desks and skills here.</p>
      <div style={{ marginTop: 12 }}>
        <Button tone="brass" onClick={onNew}>new agent</Button>
      </div>
    </EmptyPane>
  );
}

/** The view's box: the column at the left when it is not the Shell's, then the pane — its header over the page. */
function Frame({ column, children }: { column?: React.ReactNode; children?: React.ReactNode }) {
  const pane = <div style={{ position: "relative", flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>{children}</div>;
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", background: "var(--loki-bg)" }}>
      {column && (
        <div className="loki-column-body" style={{ position: "relative", width: COLUMN_DEFAULT, flex: "none", borderRight: "1px solid var(--loki-border)", background: "var(--loki-panel)" }}>
          {column}
        </div>
      )}
      {pane}
    </div>
  );
}
