import { DownloadIcon, Undo2Icon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { NewAgentOptions } from "../../../core/attention/chat-client.ts";
import { MAIN_CHAT_ID } from "../../../core/chat-scope.ts";
import type { ChatSummary, MacIdentity } from "../../../core/frame-types.ts";
import type { ModelEntry } from "../../../core/models.ts";
import type { ItemProperty } from "../item/item-view";
import { ToolbarGroup, ToolbarTitle, type ToolbarMove } from "../item/toolbar";
import { lastInput } from "../kit/motion";
import type { AccountsApi } from "../settings/accounts";
import type { McpApi } from "../settings/mcp";
import type { SettingsPage } from "../settings/pages";
import { Glyph, Icon } from "../shared/icons";
import { ContentList, NothingSelected, type ContentListHandle, type ContentRow } from "../shell/content-list";
import { FilterPills } from "../shell/filter-pills";
import { registerActions } from "../shell/keymap";
import { PlaceColumns } from "../shell/place-columns";
import { Button, EmptyPane, PaneHeader, type Tab } from "../components";

import { changePills, changeRows, ChangesPage, filterChanges, type ChangeFilter } from "./changes-page";
import { MemoryPage, memoryRows } from "./memory-page";
import { NewAgent } from "./new-agent";
import { AGENT_PAGES, AGENT_PAGE_HINT, AGENT_PAGE_LABEL, type AgentPage } from "./pages";
import { chatRows, ProfilePage } from "./profile-page";
import { readingFor, shownShaOf, shownSkillOf } from "./reading";
import { agentsHasList, agentsSelection, shownAgent, useAgentsSelection, type AgentsSelection } from "./selection";
import { SkillsPage, skillRows, type Adding } from "./skills-page";
import type { AgentEdit, AgentSkill, AgentsApi, AgentsWrite } from "./types";
import { useAgentDetails } from "./use-agent-details";
import { useReading } from "./use-reading";

export type { AgentDetails, AgentsApi, AgentsWrite } from "./types";

const said = (line: string): ItemProperty[] => [{ key: "status", label: line, editable: false }];

export interface AgentsProps {
  agents: Array<{ id: string; name: string }>;
  api: AgentsApi;
  avatar: (agentId: string) => string;
  desks: ChatSummary[];
  initialAgentId: string | null;
  onOpenChat: (agentId: string, conversationId: string) => void;
  onNewChat?: (agentId: string) => void;
  onAskToUpdate: (agentId: string, text: string) => void;
  onUpdateAgent: (agentId: string, body: AgentEdit) => Promise<string | null>;
  write: AgentsWrite;
  models?: ModelEntry[] | null;
  onLoadModels?: () => void;
  listModels?: () => Promise<ModelEntry[]>;
  mcp?: Pick<McpApi, "get" | "agent">;
  accounts?: AccountsApi;
  macs?: MacIdentity[];
  onOpenPreferences?: (page: SettingsPage) => void;
  onNotice?: (message: string) => void;
  selection?: AgentsSelection;
}

export function Agents(props: AgentsProps) {
  const { list, detail } = useAgentsPlace(props);
  return <PlaceColumns list={list} detail={detail} />;
}

interface PageList {
  title: string;
  rows: ContentRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onEnter?: (id: string) => void;
  empty: string;
  noun: string;
  newAction?: { label: string; run: () => void };
  emptyAction?: boolean;
  divided?: boolean;
  scope?: ReactNode;
  searchable?: boolean;
}

export function useAgentsPlace({
  agents,
  api,
  avatar,
  desks,
  initialAgentId,
  onOpenChat,
  onNewChat,
  onAskToUpdate,
  onUpdateAgent,
  write,
  models: propModels,
  onLoadModels: propLoadModels,
  listModels,
  mcp,
  accounts,
  macs,
  onOpenPreferences,
  onNotice,
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
  const [skillName, setSkillName] = useState<string | null>(null);
  const [pickedChat, setPickedChat] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [changeFilter, setChangeFilter] = useState<ChangeFilter>("all");
  const [pickedFor, setPickedFor] = useState(selected);
  const [queryPage, setQueryPage] = useState(page);
  if (pickedFor !== selected) {
    setPickedFor(selected);
    setFilePath("system/persona.md");
    setSha(null);
    setSkillName(null);
    setPickedChat(null);
    setQuery("");
    setChangeFilter("all");
  }
  if (queryPage !== page) {
    setQueryPage(page);
    setQuery("");
  }

  const [fetchedModels, setFetchedModels] = useState<ModelEntry[] | null>(null);
  const models = propModels !== undefined ? propModels : fetchedModels;
  const loadModels = () => {
    if (propLoadModels) propLoadModels();
    else if (listModels) void listModels().then(setFetchedModels);
  };
  const [adding, setAdding] = useState<Adding>(null);
  const [confirmRemoveSkill, setConfirmRemoveSkill] = useState<AgentSkill | null>(null);

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
    onNotice,
  });
  const { fetched, d, log } = store;
  const shownSkill = shownSkillOf(d, skillName);
  const filteredLog = filterChanges(log, changeFilter, query);
  const shownSha = shownShaOf(sha, filteredLog);
  const reading = useReading(selected, readingFor(page, filePath, shownSha, shownSkill), api);
  const created = async (opts: NewAgentOptions) => {
    const r = await write.createAgent(opts);
    if ("error" in r) return r.error;
    setSelected(r.id);
    store.flash(`${opts.name} is here`);
    return null;
  };

  const list = useRef<ContentListHandle>(null);
  useEffect(() => registerActions({ "agents.prev": () => list.current?.step(-1), "agents.next": () => list.current?.step(1) }), []);
  const detailRef = useRef<HTMLDivElement>(null);

  const name = d?.agent.name ?? agents.find((a) => a.id === selected)?.name ?? "agent";
  const pills = changePills(log, changeFilter);

  const pageList: PageList | null =
    !selected || !agentsHasList(sel, agents.length)
      ? null
      : page === "profile"
        ? {
            title: "Chats",
            rows: chatRows(desks, selected, query),
            selectedId: pickedChat,
            onSelect: (id) => {
              if (lastInput() !== "key") onOpenChat(selected, id);
              else setPickedChat(id);
            },
            onEnter: (id) => onOpenChat(selected, id),
            empty: `No live chats with ${name} yet.`,
            noun: "Chat",
            newAction: { label: "New Chat", run: () => (onNewChat ? onNewChat(selected) : onOpenChat(selected, MAIN_CHAT_ID)) },
            emptyAction: true,
            searchable: false,
          }
        : !d
          ? {
              title: AGENT_PAGE_LABEL[page],
              rows: [],
              selectedId: null,
              onSelect: () => {},
              empty: fetched.kind === "unanswered" ? "No local record" : "Reading the agent…",
              noun: "Item",
            }
          : page === "memory"
            ? {
                title: "Memory",
                rows: memoryRows(d.files, query),
                selectedId: filePath,
                onSelect: setFilePath,
                empty: query.trim() ? "No matching files." : `${name} has no memory files yet.`,
                noun: "File",
                searchable: true,
              }
            : page === "changes"
              ? {
                  title: "Changes",
                  rows: changeRows(filteredLog),
                  selectedId: shownSha,
                  onSelect: setSha,
                  empty: query.trim() ? "No matching changes." : `${name} has not learned anything yet.`,
                  noun: "Change",
                  divided: true,
                  scope: pills.length > 1 ? <FilterPills pills={pills} value={changeFilter} onValue={setChangeFilter} /> : undefined,
                  searchable: true,
                }
              : {
                  title: "Skills",
                  rows: skillRows(d.skills, query),
                  selectedId: shownSkill?.name ?? null,
                  onSelect: setSkillName,
                  empty: query.trim() ? "No matching skills." : `${name} has no skills yet.`,
                  noun: "Skill",
                  divided: true,
                  newAction: { label: "Write Skill", run: () => setAdding("write") },
                  emptyAction: false,
                  searchable: true,
                };

  const listColumn = pageList && (
    <ContentList
      key={`${selected}:${page}`}
      ref={list}
      label={`${name}: ${pageList.title}`}
      title={pageList.title}
      count={pageList.rows.length || null}
      rows={pageList.rows}
      selectedId={pageList.selectedId}
      onSelect={pageList.onSelect}
      onEnter={pageList.onEnter ?? (() => detailRef.current?.focus())}
      empty={pageList.empty}
      newAction={pageList.newAction}
      emptyAction={pageList.emptyAction ?? false}
      divided={pageList.divided}
      scope={pageList.scope}
      query={pageList.searchable ? query : undefined}
      onQuery={pageList.searchable ? setQuery : undefined}
    />
  );

  const chosenId = pageList?.rows.some((r) => r.id === pageList.selectedId) ? pageList.selectedId : null;
  const activeCommit = page === "changes" && chosenId ? (filteredLog.find((c) => c.sha === chosenId) ?? null) : null;

  const toolbarMoves: ToolbarMove[] = (() => {
    if (!d || !selected) return [];
    if (page === "profile") {
      return [
        {
          label: "Main Chat",
          icon: <Icon name="desk" size={16} />,
          run: () => onOpenChat(selected, MAIN_CHAT_ID),
          title: `Open ${name}'s main chat`,
        },
        {
          label: "New Chat",
          icon: <Icon name="compose" size={16} />,
          run: () => (onNewChat ? onNewChat(selected) : onOpenChat(selected, MAIN_CHAT_ID)),
          title: `Start a new chat with ${name}`,
          prominent: true,
        },
      ];
    }
    if (page === "memory" && chosenId) {
      return [
        {
          label: "Ask to Update",
          icon: <Icon name="compose" size={16} />,
          run: () => onAskToUpdate(selected, `In your memory file \`${chosenId}\`, please update: `),
          title: `Ask ${name} to update ${chosenId}`,
        },
      ];
    }
    if (page === "changes" && activeCommit && activeCommit.files.length > 0) {
      return [
        {
          label: "Revert",
          icon: <Glyph icon={Undo2Icon} size={16} />,
          run: () => void store.revertCommit(activeCommit.sha),
          title: "Undo this change with a new commit",
        },
      ];
    }
    if (page === "skills") {
      const moves: ToolbarMove[] = [
        {
          label: "Write Skill",
          icon: <Icon name="pencil" size={16} />,
          run: () => setAdding("write"),
          title: "Write a new skill",
        },
        {
          label: "Install Skill",
          icon: <Glyph icon={DownloadIcon} size={16} />,
          run: () => setAdding("install"),
          title: "Install a skill from GitHub, git, or a folder",
        },
      ];
      if (shownSkill?.origin === "other") {
        moves.push({
          label: "Refresh",
          icon: <Icon name="refresh" size={16} />,
          disabled: store.refreshing === shownSkill.name,
          run: () => void store.refreshSkill(shownSkill).then((err) => err && store.flash(err)),
          title: shownSkill.source
            ? `Pull the latest from ${shownSkill.source.label} and reconcile with ${name}'s copy`
            : "Say where this skill came from, then pull the latest",
        });
      }
      if (shownSkill) {
        moves.push({
          label: "Remove Skill",
          icon: <Icon name="trash" size={16} />,
          run: () => setConfirmRemoveSkill(shownSkill),
          title: `Remove ${shownSkill.name} from ${name}'s memory`,
        });
      }
      return moves;
    }
    return [];
  })();

  const header = (tabs: boolean) => (
    <PaneHeader
      title={name}
      line={<ToolbarTitle title={name} facts={said(AGENT_PAGE_HINT[page])} titleAs="h1" />}
      tabs={tabs ? PAGE_TABS : undefined}
      tab={page}
      onTab={pick}
      tabsLabel="Agent pages"
      panelId={(p) => `loki-agent-page-${p}`}
      trailing={toolbarMoves.length > 0 ? <ToolbarGroup label={`${AGENT_PAGE_LABEL[page]} actions`} moves={toolbarMoves} /> : undefined}
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
          confirmDelete={store.confirmDelete}
          setConfirmDelete={store.setConfirmDelete}
          onRemove={store.remove}
        />
      );
    }
    if (page === "skills") {
      return (
        <SkillsPage
          d={d}
          store={store}
          viewSkill={shownSkill}
          adding={adding}
          setAdding={setAdding}
          confirmRemove={confirmRemoveSkill}
          setConfirmRemove={setConfirmRemoveSkill}
          reading={reading}
          onOpenGlobalSkills={onOpenPreferences ? () => onOpenPreferences("skills") : undefined}
        />
      );
    }
    if (!chosenId) return <NothingSelected noun={pageList?.noun ?? "Item"} />;
    if (page === "memory") return <MemoryPage d={d} filePath={chosenId} reading={reading} />;
    return activeCommit ? <ChangesPage commit={activeCommit} reading={reading} /> : null;
  };

  const detailBody = ((): ReactNode => {
    if (!agents.length) return <NoAgents onNew={() => setCreating(true)} />;
    if (!selected) return null;
    if (fetched.kind === "reading") {
      return (
        <>
          {header(false)}
          <EmptyPane title="Reading the agent…" />
        </>
      );
    }
    if (fetched.kind === "unanswered") {
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
        {creating && <NewAgent models={models} onLoadModels={loadModels} onCreate={created} onCancel={() => setCreating(false)} canCancel />}
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
        <Button tone="positive" onClick={onNew}>
          New Agent
        </Button>
      </div>
    </EmptyPane>
  );
}
