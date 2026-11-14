import type { McpApi } from "../settings/mcp";
import type { AccountsApi } from "../settings/accounts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { NewAgentOptions } from "../../../core/attention/chat-client.ts";

import { registerActions } from "../shell/keymap";
import { Button, EmptyPane, PaneHeader, type Tab } from "../components";
import { ToolbarTitle } from "../item/toolbar";
import type { ItemProperty } from "../item/item-view";
import { ContentList, NothingSelected, type ContentListHandle, type ContentRow } from "../shell/content-list";
import { PlaceColumns } from "../shell/place-columns";

import { AGENT_PAGES, AGENT_PAGE_HINT, AGENT_PAGE_LABEL, type AgentPage } from "./pages";
import { readingFor, shownShaOf, shownSkillOf } from "./reading";
import { agentsHasList, agentsSelection, shownAgent, useAgentsSelection, type AgentsSelection } from "./selection";
import { useAgentDetails } from "./use-agent-details";
import { useReading } from "./use-reading";
import { NewAgent } from "./new-agent";
import { ProfilePage } from "./profile-page";
import { MemoryPage, memoryRows } from "./memory-page";
import { ChangesPage, changeRows } from "./changes-page";
import { ReflectionPage, reflectionRuns } from "./reflection-page";
import { SkillsPage, skillRows, type Adding } from "./skills-page";
import type { AgentEdit, AgentsApi, AgentsWrite, ReflectionControls } from "./types";
import type { MacIdentity } from "../../../core/frame-types.ts";
import type { DeskSummary } from "../../../core/frame-types.ts";

export type { AgentDetails, AgentsApi, AgentsWrite } from "./types";

/** One line of words as a toolbar's grey line, or none. */
const said = (line: string | null | undefined): ItemProperty[] => (line ? [{ key: "status", label: line, editable: false }] : []);

/** The props of the Agents place: the agents, the reads and writes through loki's daemon, and where its links go. */
export interface AgentsProps {
  agents: Array<{ id: string; name: string }>;
  api: AgentsApi;
  avatar: (agentId: string) => string;
  desks: DeskSummary[];
  initialAgentId: string | null;
  onOpenDesk: (agentId: string, conversationId: string) => void;
  /** Open the agent's main chat with a prefilled request to change a memory file. */
  onAskToUpdate: (agentId: string, text: string) => void;
  /** Through loki's daemon; resolves to an error message or null. */
  onUpdateAgent: (agentId: string, body: AgentEdit) => Promise<string | null>;
  write: AgentsWrite;
  /** Reflection's settings and a pass by hand, through loki's daemon. */
  reflect: ReflectionControls;
  listModels: () => Promise<Array<{ handle: string }>>;
  onShowDesks: () => void;
  /** The MCP servers, to switch on and off for the agent (Profile). */
  mcp?: Pick<McpApi, "get" | "agent">;
  /** The Inbox accounts, so deleting an agent that owns some offers to move or disconnect each (plan 067, R4). */
  accounts?: AccountsApi;
  /** This Mac first, then the Macs paired with it (plan 023): where an agent may live. */
  macs?: MacIdentity[];
  /** The chosen agent, page and new-agent form, shared with the sidebar's Agents sources; the window's one by default. */
  selection?: AgentsSelection;
}

/**
 * The Agents place (plan 2026-11-14-1330, KTD9): its owner, drawing the list column and the detail from one state. The
 * agents are the sidebar's sources (agents-column.tsx); the list holds the chosen page's items, and the detail the item
 * chosen in it under a toolbar whose centred tabs are the pages. Profile has no items, so its form spans both columns.
 */
export function Agents(props: AgentsProps) {
  const { list, detail } = useAgentsPlace(props);
  return <PlaceColumns list={list} detail={detail} />;
}

/** A page's items as the list shows them: the rows, the one chosen, how to choose another, and what an empty page says. */
interface PageList {
  rows: ContentRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  empty: string;
  /** The item's name in "No … Selected". */
  noun: string;
}

/**
 * The Agents place's two columns from one state (KTD1, KTD9): the file path, the commit, the run and the skill chosen
 * are held here, above the pages, so the list and the detail read the same choice. The list is null where the page
 * has no items (Profile, the new-agent form, the invitation), which the shell reads as `agentsHasList` to span them.
 */
export function useAgentsPlace({
  agents,
  api,
  avatar,
  desks,
  initialAgentId,
  onOpenDesk,
  onAskToUpdate,
  onUpdateAgent,
  write,
  reflect,
  listModels,
  onShowDesks,
  mcp,
  accounts,
  macs,
  selection = agentsSelection,
}: AgentsProps): { list: ReactNode; detail: ReactNode } {
  const sel = useAgentsSelection(selection);
  /** The agent the sidebar picked; with nothing picked the desk's agent, and after a delete the first agent. */
  const selected = shownAgent(sel.agent, initialAgentId, agents);
  const { page, creating } = sel;
  const pick = selection.pickPage;
  const setSelected = selection.pickAgent;
  const setCreating = selection.setCreating;
  /** What each page has picked; the memory, changes, reflection and skills pages start over for another agent. */
  const [filePath, setFilePath] = useState("system/persona.md");
  const [sha, setSha] = useState<string | null>(null);
  const [runSha, setRunSha] = useState<string | null>(null);
  const [skillName, setSkillName] = useState<string | null>(null);
  const [pickedFor, setPickedFor] = useState(selected);
  if (pickedFor !== selected) {
    // state derived from the selection, reset during render (the React pattern), so the new agent's first paint is clean
    setPickedFor(selected);
    setFilePath("system/persona.md");
    setSha(null);
    setRunSha(null);
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
  const runs = reflectionRuns(log);
  const shownRun = shownShaOf(runSha, runs);
  const reading = useReading(selected, readingFor(page, filePath, shownSha, shownSkill, shownRun), api);
  const created = async (opts: NewAgentOptions) => {
    const r = await write.createAgent(opts);
    if ("error" in r) return r.error;
    setSelected(r.id); // closes the form too
    flash(`${opts.name} is here`);
    return null;
  };

  // ⌘[ and ⌘] step the list's rows (R16; agents.prev / agents.next in the keymap); a page with no list has none to step.
  const list = useRef<ContentListHandle>(null);
  useEffect(() => registerActions({ "agents.prev": () => list.current?.step(-1), "agents.next": () => list.current?.step(1) }), []);
  /** Return or Tab on a row: focus goes into the detail's reading pane. */
  const detailRef = useRef<HTMLDivElement>(null);

  const name = d?.agent.name ?? agents.find((a) => a.id === selected)?.name ?? "agent";
  const pageList: PageList | null =
    // The shell's rule for whether the list column shows (agentsHasList), so the two never disagree.
    !selected || !agentsHasList(sel, agents.length)
      ? null
      : !d
        ? { rows: [], selectedId: null, onSelect: () => {}, empty: d === null ? "No local record" : "Reading the agent…", noun: "Item" }
        : page === "memory"
          ? { rows: memoryRows(d.files), selectedId: filePath, onSelect: setFilePath, empty: `${name} has no memory files yet.`, noun: "File" }
          : page === "changes"
            ? { rows: changeRows(log), selectedId: shownSha, onSelect: setSha, empty: `${name} has not learned anything yet.`, noun: "Change" }
            : page === "reflection"
              ? { rows: changeRows(runs), selectedId: shownRun, onSelect: setRunSha, empty: `Reflection has not changed ${name}'s memory lately.`, noun: "Run" }
              : { rows: skillRows(d.skills), selectedId: shownSkill?.name ?? null, onSelect: setSkillName, empty: `${name} has no skills yet.`, noun: "Skill" };
  const listColumn = pageList && (
    // Keyed by agent and page, so a highlight or a held row never carries over to another agent's or page's rows.
    <ContentList
      key={`${selected}:${page}`}
      ref={list}
      label={`${name}: ${AGENT_PAGE_LABEL[page]}`}
      title={AGENT_PAGE_LABEL[page]}
      count={pageList.rows.length || null}
      rows={pageList.rows}
      selectedId={pageList.selectedId}
      onSelect={pageList.onSelect}
      onEnter={() => detailRef.current?.focus()}
      empty={pageList.empty}
      newAction={{ label: "New Agent", run: () => setCreating(true) }}
      emptyAction={false}
    />
  );

  const header = (tabs: boolean) => (
    // The chat's toolbar anatomy (plan 2026-11-14-1300, 3): the agent's name over a grey line saying what the page
    // shows, or what just happened, and the pages as tab views centred in the toolbar (plan 2026-11-14-1330, KTD11).
    <PaneHeader
      title={name}
      line={<ToolbarTitle title={name} facts={said(notice ?? (tabs ? AGENT_PAGE_HINT[page] : null))} titleAs="h1" />}
      tabs={tabs ? PAGE_TABS : undefined}
      tab={page}
      onTab={pick}
      tabsLabel="Agent pages"
      panelId={(p) => `loki-agent-page-${p}`}
    />
  );

  /** The detail for the page showing: Profile's form, or the item chosen in the list, or "No … Selected". */
  const item = (): ReactNode => {
    if (!d || !selected) return null;
    if (page === "profile") {
      return (
        <ProfilePage
          d={d}
          selected={selected}
          mcp={mcp}
          accounts={accounts ? { api: accounts, agents } : undefined}
          macs={macs}
          avatar={avatar(selected)}
          models={models}
          onLoadModels={loadModels}
          onSave={store.save}
          desks={desks}
          onOpenDesk={onOpenDesk}
          onShowDesks={onShowDesks}
          confirmDelete={store.confirmDelete}
          setConfirmDelete={store.setConfirmDelete}
          onRemove={store.remove}
        />
      );
    }
    const revert = (sha: string) => void store.revertCommit(sha);
    // Reflection's settings are for every agent, so they show with or without a run to read.
    if (page === "reflection") {
      const run = runs.find((c) => c.sha === shownRun) ?? null;
      return (
        <ReflectionPage key={selected} agentId={selected} agentName={d.agent.name} api={api} reflect={reflect} run={run} reading={reading} onRevert={revert} />
      );
    }
    // Skills' Write and Install show with no skill chosen too, since they are how the first one comes.
    if (page === "skills") return <SkillsPage d={d} store={store} viewSkill={shownSkill} adding={adding} setAdding={setAdding} reading={reading} />;
    const chosen = pageList?.rows.some((r) => r.id === pageList.selectedId) ? pageList.selectedId : null;
    if (!chosen) return <NothingSelected noun={pageList?.noun ?? "Item"} />;
    if (page === "memory") return <MemoryPage d={d} selected={selected} filePath={chosen} reading={reading} onAskToUpdate={onAskToUpdate} />;
    const commit = log.find((c) => c.sha === chosen);
    return commit ? <ChangesPage commit={commit} reading={reading} onRevert={revert} /> : null;
  };

  const detailBody = ((): ReactNode => {
    if (!agents.length && !creating) return <NoAgents onNew={() => setCreating(true)} />;
    if (creating) {
      return (
        <>
          <PaneHeader title="New Agent" line={<ToolbarTitle title="New Agent" facts={said(notice)} titleAs="h1" />} />
          <NewAgent models={models} onLoadModels={loadModels} onCreate={created} onCancel={() => setCreating(false)} canCancel={agents.length > 0} />
        </>
      );
    }
    if (!selected) return null;
    if (d === undefined) {
      return (
        <>
          {header(false)}
          <EmptyPane title="Reading the agent…" />
        </>
      );
    }
    if (d === null) {
      return (
        <>
          {header(false)}
          <EmptyPane title="No local record">
            <p>This agent has no local record on this machine (a remote or hidden agent).</p>
          </EmptyPane>
        </>
      );
    }
    return (
      <>
        {header(true)}
        {/* The page under the agent's toolbar, its item or its form; the page is remembered for the window. */}
        <div ref={detailRef} tabIndex={-1} id={`loki-agent-page-${page}`} role="tabpanel" aria-label={AGENT_PAGE_LABEL[page]} className="loki-agents-page">
          {item()}
        </div>
      </>
    );
  })();

  return {
    list: listColumn,
    // The detail's own presses stay in it (the desk's canvas under it listens for them on the window).
    detail: (
      <div className="loki-agents-detail" onPointerDown={(e) => e.stopPropagation()}>
        {detailBody}
      </div>
    ),
  };
}

/** The pages as the toolbar's tab views. */
const PAGE_TABS: ReadonlyArray<Tab<AgentPage>> = AGENT_PAGES.map((p) => ({ id: p, label: AGENT_PAGE_LABEL[p] }));

/** Before the first agent: an invitation, as the pane's empty state. */
function NoAgents({ onNew }: { onNew: () => void }) {
  return (
    <EmptyPane title="No agents yet">
      <p>An agent keeps its own memory, chats and skills here.</p>
      <div style={{ marginTop: 12 }}>
        <Button tone="brass" onClick={onNew}>
          New Agent
        </Button>
      </div>
    </EmptyPane>
  );
}
