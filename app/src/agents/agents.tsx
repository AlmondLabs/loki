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

const said = (line: string | null | undefined): ItemProperty[] => (line ? [{ key: "status", label: line, editable: false }] : []);

export interface AgentsProps {
  agents: Array<{ id: string; name: string }>;
  api: AgentsApi;
  avatar: (agentId: string) => string;
  desks: DeskSummary[];
  initialAgentId: string | null;
  onOpenDesk: (agentId: string, conversationId: string) => void;
  onAskToUpdate: (agentId: string, text: string) => void;
  onUpdateAgent: (agentId: string, body: AgentEdit) => Promise<string | null>;
  write: AgentsWrite;
  reflect: ReflectionControls;
  listModels: () => Promise<Array<{ handle: string }>>;
  onShowDesks: () => void;
  mcp?: Pick<McpApi, "get" | "agent">;
  accounts?: AccountsApi;
  macs?: MacIdentity[];
  selection?: AgentsSelection;
}

export function Agents(props: AgentsProps) {
  const { list, detail } = useAgentsPlace(props);
  return <PlaceColumns list={list} detail={detail} />;
}

interface PageList {
  rows: ContentRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  empty: string;
  noun: string;
}

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
  const selected = shownAgent(sel.agent, initialAgentId, agents);
  const { page, creating } = sel;
  const pick = selection.pickPage;
  const setSelected = selection.pickAgent;
  const setCreating = selection.setCreating;
  const [filePath, setFilePath] = useState("system/persona.md");
  const [sha, setSha] = useState<string | null>(null);
  const [runSha, setRunSha] = useState<string | null>(null);
  const [skillName, setSkillName] = useState<string | null>(null);
  const [pickedFor, setPickedFor] = useState(selected);
  if (pickedFor !== selected) {
    setPickedFor(selected);
    setFilePath("system/persona.md");
    setSha(null);
    setRunSha(null);
    setSkillName(null);
  }
  const [models, setModels] = useState<string[] | null>(null);
  const loadModels = () => void listModels().then((m) => setModels([...new Set(m.map((e) => e.handle))]));
  const [adding, setAdding] = useState<Adding>(null);

  const store = useAgentDetails({
    selected,
    api,
    write,
    onUpdateAgent,
    onAskToUpdate,
    onDeleted: selection.agentDeleted,
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
    setSelected(r.id);
    flash(`${opts.name} is here`);
    return null;
  };

  const list = useRef<ContentListHandle>(null);
  useEffect(() => registerActions({ "agents.prev": () => list.current?.step(-1), "agents.next": () => list.current?.step(1) }), []);
  const detailRef = useRef<HTMLDivElement>(null);

  const name = d?.agent.name ?? agents.find((a) => a.id === selected)?.name ?? "agent";
  const pageList: PageList | null =
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
    if (page === "reflection") {
      const run = runs.find((c) => c.sha === shownRun) ?? null;
      return (
        <ReflectionPage key={selected} agentId={selected} agentName={d.agent.name} api={api} reflect={reflect} run={run} reading={reading} onRevert={revert} />
      );
    }
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
        <div ref={detailRef} tabIndex={-1} id={`loki-agent-page-${page}`} role="tabpanel" aria-label={AGENT_PAGE_LABEL[page]} className="loki-agents-page">
          {item()}
        </div>
      </>
    );
  })();

  return {
    list: listColumn,
    detail: (
      <div className="loki-agents-detail" onPointerDown={(e) => e.stopPropagation()}>
        {detailBody}
      </div>
    ),
  };
}

const PAGE_TABS: ReadonlyArray<Tab<AgentPage>> = AGENT_PAGES.map((p) => ({ id: p, label: AGENT_PAGE_LABEL[p] }));

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
