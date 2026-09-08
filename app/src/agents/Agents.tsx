import { useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { LocalAgent, MemoryCommit, MemoryFile, MemorySkill } from "../../../mod/agents.ts";
import type { GlobalSkill } from "../../../mod/skills.ts";
import type { MemorySkillInfo, RefreshOutcome } from "../../../mod/skill-sources.ts";
import { PERSONALITIES, type Personality } from "../../../packages/core/src/attention/protocol.ts";
import type { DeskSummary } from "../desk/useDesk";
import { AgentFace } from "../desk/AgentChip";
import { Button, Chip, Empty, Field, NavButton, Row, TextArea, Title } from "../ui";
import type { Task } from "../board/model";
import { ago } from "../board/model";
import { stripFrontmatter } from "../phone/model";
import { AGENT_PAGES, AGENT_PAGE_HINT, AGENT_PAGE_KEY, DEFAULT_AGENT_PAGE, isAgentPage, type AgentPage } from "./pages";

export interface AgentDetails {
  agent: LocalAgent;
  files: MemoryFile[];
  skills: MemorySkillInfo[];
  hasProfile: boolean;
  lastCommit: MemoryCommit | null;
}

export interface AgentsApi {
  get: (agentId: string) => Promise<AgentDetails | null>;
  read: (agentId: string, path: string) => Promise<string | null>;
  log: (agentId: string, path?: string, limit?: number) => Promise<MemoryCommit[]>;
  diff: (agentId: string, sha: string) => Promise<string | null>;
  globalSkills: () => Promise<GlobalSkill[]>;
  /** `letta install <source> --agent <id>` through the mod; an error message or null. */
  installSkill: (agentId: string, source: string, force?: boolean) => Promise<string | null>;
  /** Fetch an installed skill's upstream and replace, stage for the agent to reconcile, or report it current (mod/skill-sources.ts). */
  refreshSkill: (agentId: string, name: string, source?: string) => Promise<RefreshOutcome | { error: string }>;
}

/** Writes through the app-server; each resolves to an error message or null. */
export interface AgentsWrite {
  createAgent: (opts: { personality: Personality; name: string; description?: string; model?: string }) => Promise<{ id: string } | { error: string }>;
  deleteAgent: (agentId: string) => Promise<string | null>;
  writeMemory: (agentId: string, path: string, content: string, message?: string) => Promise<string | null>;
  removeMemory: (agentId: string, path: string, message?: string) => Promise<string | null>;
}

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
  onUpdateAgent: (agentId: string, body: { name?: string; description?: string; model?: string }) => Promise<string | null>;
  write: AgentsWrite;
  listModels: () => Promise<Array<{ handle: string }>>;
  onShowDesks: () => void;
  onShowBoard: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(initialAgentId ?? agents[0]?.id ?? null);
  useEffect(() => {
    if (!selected && agents[0]) setSelected(agents[0].id);
  }, [agents, selected]);
  const [details, setDetails] = useState<Record<string, AgentDetails | null | undefined>>({});
  const [commits, setCommits] = useState<Record<string, MemoryCommit[]>>({});
  /** The page down the left, remembered for the window; and what each page has picked. */
  const [page, setPageState] = useState<AgentPage>(() => {
    const saved = sessionStorage.getItem(AGENT_PAGE_KEY);
    return isAgentPage(saved) ? saved : DEFAULT_AGENT_PAGE;
  });
  const pick = (p: AgentPage) => {
    setPageState(p);
    sessionStorage.setItem(AGENT_PAGE_KEY, p);
  };
  const [filePath, setFilePath] = useState("system/persona.md");
  const [sha, setSha] = useState<string | null>(null);
  const [skillName, setSkillName] = useState<string | null>(null);
  const dNow = selected ? details[selected] : undefined;
  const logNow = selected ? commits[selected] ?? [] : [];
  const shownSkill = dNow ? dNow.skills.find((x) => x.name === skillName) ?? dNow.skills[0] ?? null : null;
  const shownSha = sha ?? logNow[0]?.sha ?? null;
  /** What the reading pane shows: the memory file, the commit, or the skill's SKILL.md — by page. */
  const view: { kind: "file"; path: string } | { kind: "commit"; sha: string } | null = page === "memory" ? { kind: "file", path: filePath } : page === "changes" ? (shownSha ? { kind: "commit", sha: shownSha } : null) : page === "skills" ? (shownSkill ? { kind: "file", path: shownSkill.path } : null) : null;
  const [content, setContent] = useState<string | null>(null);
  const [loadingView, setLoadingView] = useState(false);
  const [models, setModels] = useState<string[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async (id: string) => {
    const d = await api.get(id);
    setDetails((x) => ({ ...x, [id]: d }));
    const log = await api.log(id, undefined, 40);
    setCommits((x) => ({ ...x, [id]: log }));
  };
  useEffect(() => {
    if (!selected) return;
    setFilePath("system/persona.md");
    setSha(null);
    setSkillName(null);
    if (details[selected] === undefined) void load(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);
  useEffect(() => {
    if (!selected || !view) return;
    let cancelled = false;
    setLoadingView(true);
    const p = view.kind === "file" ? api.read(selected, view.path) : api.diff(selected, view.sha);
    void p.then((c) => {
      if (cancelled) return;
      setContent(c);
      setLoadingView(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, view?.kind, view?.kind === "file" ? view.path : view?.sha]);

  const d = selected ? details[selected] : undefined;
  const log = selected ? commits[selected] ?? [] : [];
  /** The skill the reading pane is showing, on the skills page. */
  const viewSkill = page === "skills" ? shownSkill : null;
  const myDesks = useMemo(() => desks.filter((x) => x.agentId === selected && x.status === "live"), [desks, selected]);
  const myTasks = useMemo(() => (tasks ?? []).filter((t) => t.status !== "closed" && (t.metadata.assignedAgentId === selected || t.assignee === d?.agent.name)), [tasks, selected, d]);
  const flash = (m: string) => {
    setNotice(m);
    setTimeout(() => setNotice((c) => (c === m ? null : c)), 3000);
  };
  const save = async (body: { name?: string; description?: string; model?: string }) => {
    if (!selected) return;
    const err = await onUpdateAgent(selected, body);
    if (err) return flash(err);
    flash("saved");
    void load(selected);
  };
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** The skills section's add form (write here, or install from a source), and whether the global list is unfolded. */
  const [adding, setAdding] = useState<null | "write" | "install">(null);
  const created = async (opts: { personality: Personality; name: string; description?: string; model?: string }) => {
    const r = await write.createAgent(opts);
    if ("error" in r) return r.error;
    setCreating(false);
    setSelected(r.id);
    flash(`${opts.name} is here`);
    return null;
  };
  const remove = async () => {
    if (!selected || !d) return;
    const name = d.agent.name;
    const err = await write.deleteAgent(selected);
    setConfirmDelete(false);
    if (err) return flash(err);
    setDetails((x) => ({ ...x, [selected]: undefined }));
    setSelected(null);
    flash(`${name} deleted`);
  };
  const removeSkill = async (skill: MemorySkill) => {
    if (!selected || !d) return;
    const dir = `skills/${skill.name}/`;
    const files = d.files.filter((f) => f.path.startsWith(dir)).map((f) => f.path);
    for (const path of files.length ? files : [skill.path]) {
      const err = await write.removeMemory(selected, path, `chore: remove skill ${skill.name}`);
      if (err) return flash(err);
    }
    flash(`${skill.name} removed`);
    void load(selected);
  };
  const addSkill = async (name: string, markdown: string) => {
    if (!selected) return "no agent selected";
    const path = `skills/${name}/SKILL.md`;
    const err = await write.writeMemory(selected, path, markdown, `feat: add skill ${name}`);
    if (err) return err;
    flash(`${name} added`);
    void load(selected);
    setSkillName(name);
    pick("skills");
    return null;
  };
  const installSkill = async (source: string) => {
    if (!selected) return "no agent selected";
    const err = await api.installSkill(selected, source, true);
    if (err) return err;
    flash("installed");
    void load(selected);
    return null;
  };
  /**
   * Refresh an installed skill from where it came from. Current: say so. Untouched and changed upstream:
   * the mod replaced it. Edited by the agent: the mod staged upstream and the agent is asked, in its main
   * chat, to reconcile — the request is prefilled, you send it. No known source: ask for one, once.
   */
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [needsSource, setNeedsSource] = useState<string | null>(null);
  const refreshSkill = async (skill: MemorySkillInfo, source?: string): Promise<string | null> => {
    if (!selected || !d) return "no agent selected";
    if (!source && !skill.source) {
      setNeedsSource(skill.name);
      return null;
    }
    setRefreshing(skill.name);
    const r = await api.refreshSkill(selected, skill.name, source);
    setRefreshing(null);
    if ("error" in r) return r.error;
    setNeedsSource(null);
    if (r.outcome === "current") flash(`${skill.name} is current (${r.label})`);
    else if (r.outcome === "replaced") flash(`${skill.name} refreshed from ${r.label}: ${r.changed.length} file${r.changed.length === 1 ? "" : "s"}`);
    else {
      flash(`${skill.name}: upstream changed and so did ${d.agent.name}'s copy — asking ${d.agent.name} to reconcile`);
      onAskToUpdate(selected, r.prompt);
    }
    void load(selected);
    return null;
  };

  if (!agents.length && !creating) {
    return (
      <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
        <Empty title="No agents yet.">
          <p>An agent keeps its own memory, desks and skills here.</p>
          <div style={{ marginTop: 12 }}>
            <Button tone="brass" onClick={() => setCreating(true)}>new agent</Button>
          </div>
        </Empty>
      </div>
    );
  }

  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", background: "var(--loki-bg)" }}>
      {/* tabs: one face per agent */}
      <div role="tablist" aria-label="agents" style={{ display: "flex", gap: 6, padding: "12px 24px 0", borderBottom: "1px solid var(--loki-border)" }}>
        {agents.map((a) => (
          <button
            key={a.id}
            role="tab"
            aria-selected={a.id === selected}
            onClick={() => setSelected(a.id)}
            style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "8px 14px 10px", border: "none", borderBottom: `2px solid ${a.id === selected ? "var(--loki-accent)" : "transparent"}`, background: "transparent", color: a.id === selected ? "var(--loki-fg)" : "var(--loki-muted)", cursor: "pointer", font: "inherit", fontFamily: "var(--loki-font)", fontSize: 13.5 }}
          >
            <AgentFace name={a.name} src={avatar(a.id)} size={22} />
            {a.name}
          </button>
        ))}
        <button role="tab" aria-selected={creating} onClick={() => setCreating(true)} title="a new agent" style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 12px 10px", border: "none", borderBottom: `2px solid ${creating ? "var(--loki-accent)" : "transparent"}`, background: "transparent", color: creating ? "var(--loki-fg)" : "var(--loki-muted)", cursor: "pointer", font: "inherit", fontFamily: "var(--loki-font)", fontSize: 13.5 }}>
          + new
        </button>
        <span style={{ flex: 1 }} />
        {notice && <span style={{ alignSelf: "center", fontSize: 12, color: "var(--loki-accent)" }}>{notice}</span>}
      </div>

      {creating && <NewAgent models={models} onLoadModels={() => void listModels().then((m) => setModels(m.map((e) => e.handle)))} onCreate={created} onCancel={() => setCreating(false)} canCancel={agents.length > 0} />}

      {!creating && selected && d === undefined && (
        <div style={{ flex: 1, display: "grid", placeItems: "center" }}>
          <Empty title="reading the agent…" />
        </div>
      )}
      {!creating && selected && d === null && (
        <div style={{ flex: 1, display: "grid", placeItems: "center" }}>
          <Empty title="No local record">
            <p>This agent has no local record on this machine (a remote or hidden agent).</p>
          </Empty>
        </div>
      )}
      {!creating && selected && d && (
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

            {page === "profile" && (
              <div style={{ minWidth: 0, minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: "22px 28px 32px" }}>
                <div style={{ maxWidth: 760, display: "grid", gap: 28 }}>
                  <Identity d={d} avatar={avatar(selected)} models={models} onLoadModels={() => void listModels().then((m) => setModels(m.map((e) => e.handle)))} onSave={save} />

                  <section>
                    <Head>
                      desks <span style={{ marginLeft: "auto", letterSpacing: 0, fontFamily: "var(--loki-mono)" }}>{myDesks.length ? `${myDesks.length} live` : ""}</span>
                    </Head>
                    {myDesks.length === 0 && <div style={{ fontSize: 12, color: "var(--loki-muted)", padding: "0 8px" }}>no live desks</div>}
                    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 2 }}>
                      {myDesks.map((x) => (
                        <Row dense key={x.scope} onClick={() => onOpenDesk(selected, x.conversationId ?? "default")} style={{ justifyContent: "space-between", fontSize: 13.5 }}>
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.title ?? "main chat"}</span>
                          <span style={{ fontFamily: "var(--loki-mono)", fontSize: 10.5, color: "var(--loki-muted)", flex: "0 0 auto" }}>{x.active ? "active" : x.lastActive ? ago(x.lastActive) : ""}</span>
                        </Row>
                      ))}
                    </div>
                    <div style={{ display: "flex", gap: 8, padding: "8px 8px 0" }}>
                      <Button tone="brass" onClick={() => onOpenDesk(selected, "default")}>main chat</Button>
                      <Button onClick={onShowDesks} kbd="⌘K">the desk tree</Button>
                    </div>
                  </section>

                  <section>
                    <Head>
                      tasks <span style={{ marginLeft: "auto", letterSpacing: 0, fontFamily: "var(--loki-mono)" }}>{myTasks.length ? `${myTasks.length} open` : ""}</span>
                    </Head>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 8px", fontSize: 13.5, color: "var(--loki-muted)" }}>
                      <span>{myTasks.length === 0 ? "nothing assigned" : `${myTasks.length} assigned on the board`}</span>
                      <Button onClick={onShowBoard} kbd="⌘3">board</Button>
                    </div>
                  </section>

                  <div style={{ paddingTop: 8 }}>
                    {confirmDelete ? (
                      <div role="alertdialog" aria-label={`delete ${d.agent.name}`} style={{ display: "grid", gap: 8, padding: "10px 12px", border: "1px solid var(--loki-negative)", borderRadius: 8, fontSize: 12, color: "var(--loki-fg)", lineHeight: 1.5 }}>
                        <span>
                          Delete <b>{d.agent.name}</b> and its memory. {myDesks.length ? `${myDesks.length} live desk${myDesks.length === 1 ? "" : "s"} (${myDesks.slice(0, 3).map((x) => x.title ?? "main chat").join(", ")}${myDesks.length > 3 ? ", …" : ""}) close.` : ""}
                          {myTasks.length ? ` ${myTasks.length} open task${myTasks.length === 1 ? "" : "s"} stay on the board, unassigned.` : ""}
                        </span>
                        <div style={{ display: "flex", gap: 8 }}>
                          <Button tone="negative" onClick={() => void remove()}>delete {d.agent.name}</Button>
                          <Button onClick={() => setConfirmDelete(false)}>keep</Button>
                        </div>
                      </div>
                    ) : (
                      <Button tone="negative" onClick={() => setConfirmDelete(true)}>delete this agent…</Button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {page === "memory" && (
              <div style={{ minHeight: 0, display: "grid", gridTemplateColumns: "minmax(260px, 340px) 1fr" }}>
                <div style={{ minWidth: 0, minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: "14px 16px 24px 28px", borderRight: "1px solid var(--loki-border)" }}>
                  <Head>files{d.lastCommit ? <span style={{ marginLeft: "auto", letterSpacing: 0, fontFamily: "var(--loki-mono)" }}>last change {ago(d.lastCommit.at)}</span> : null}</Head>
                  <Tree files={d.files.filter((f) => !f.path.startsWith("skills/") && f.path !== "profile.png")} current={filePath} onPick={setFilePath} />
                </div>
                <div style={{ minWidth: 0, minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: "14px 28px 24px" }}>
                  <div className="loki-label" style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 9.5, marginBottom: 12 }}>
                    <span style={{ color: "var(--loki-fg)", letterSpacing: 0, fontFamily: "var(--loki-mono)", textTransform: "none" }}>{filePath}</span>
                    {loadingView && <span>loading…</span>}
                    <span style={{ flex: 1 }} />
                    <Button size="sm" tone="brass" onClick={() => onAskToUpdate(selected, `In your memory file \`${filePath}\`, please update: `)} title="opens the agent's main chat with the request started">
                      ask {d.agent.name} to update this
                    </Button>
                  </div>
                  {content === null && !loadingView && <div style={{ fontSize: 12, color: "var(--loki-muted)" }}>nothing to show here (binary, too large, or gone)</div>}
                  {content !== null && (
                    <div className="loki-md" style={{ fontSize: 13.5, lineHeight: 1.6, color: "var(--loki-fg)", maxWidth: 760, overflowWrap: "anywhere" }}>
                      <Markdown remarkPlugins={[remarkGfm]}>{stripFrontmatter(content)}</Markdown>
                    </div>
                  )}
                </div>
              </div>
            )}

            {page === "changes" && (
              <div style={{ minHeight: 0, display: "grid", gridTemplateColumns: "minmax(320px, 440px) 1fr" }}>
                <div style={{ minWidth: 0, minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: "14px 16px 24px 28px", borderRight: "1px solid var(--loki-border)" }}>
                  <Head>commits <span style={{ marginLeft: "auto", letterSpacing: 0, fontFamily: "var(--loki-mono)" }}>{log.length ? `last ${log.length}` : ""}</span></Head>
                  {log.length === 0 && <div style={{ fontSize: 12, color: "var(--loki-muted)", padding: "0 8px" }}>no memory commits yet</div>}
                  <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 2 }}>
                    {log.map((c) => {
                      const on = c.sha === shownSha;
                      return (
                        <Row dense key={c.sha} selected={on} onClick={() => setSha(c.sha)} style={{ display: "grid", gridTemplateColumns: "44px 1fr", gap: "2px 10px", alignItems: "baseline", fontSize: 13.5 }}>
                          <span style={{ fontFamily: "var(--loki-mono)", fontSize: 10.5, color: "var(--loki-muted)" }}>{ago(c.at)}</span>
                          <span style={{ lineHeight: 1.4 }}>{c.message}</span>
                          <span />
                          <span style={{ fontFamily: "var(--loki-mono)", fontSize: 10.5, color: "var(--loki-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.files.length === 0 ? "merge" : c.files.length === 1 ? c.files[0] : `${c.files.length} files`}</span>
                        </Row>
                      );
                    })}
                  </div>
                </div>
                <div style={{ minWidth: 0, minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: "14px 28px 24px" }}>
                  {shownSha && (
                    <div className="loki-label" style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 9.5, marginBottom: 12 }}>
                      <span style={{ color: "var(--loki-fg)", letterSpacing: 0, fontFamily: "var(--loki-mono)", textTransform: "none" }}>commit {shownSha.slice(0, 8)}</span>
                      {loadingView && <span>loading…</span>}
                    </div>
                  )}
                  {!shownSha && <div style={{ fontSize: 12, color: "var(--loki-muted)" }}>nothing learned yet</div>}
                  {shownSha && content === null && !loadingView && <div style={{ fontSize: 12, color: "var(--loki-muted)" }}>nothing to show here</div>}
                  {shownSha && content !== null && <Diff text={content} />}
                </div>
              </div>
            )}

            {page === "skills" && (
              <div style={{ minHeight: 0, display: "grid", gridTemplateColumns: "minmax(260px, 340px) 1fr" }}>
                <div style={{ minWidth: 0, minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: "14px 16px 24px 28px", borderRight: "1px solid var(--loki-border)" }}>
                  <Head>
                    skills
                    <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8 }}>
                      <Chip label active={adding === "write"} aria-pressed={adding === "write"} onClick={() => setAdding(adding === "write" ? null : "write")}>write</Chip>
                      <Chip label active={adding === "install"} aria-pressed={adding === "install"} onClick={() => setAdding(adding === "install" ? null : "install")}>install</Chip>
                    </span>
                  </Head>
                  {adding && <SkillAdd key={adding} mode={adding} onWrite={addSkill} onInstall={installSkill} onClose={() => setAdding(null)} agentName={d.agent.name} />}
                  {d.skills.length === 0 && !adding && <div style={{ fontSize: 12, color: "var(--loki-muted)", padding: "0 8px" }}>none in memory</div>}
                  <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 10 }}>
                    {(["self", "other"] as const).map((origin) => {
                      const list = d.skills.filter((x) => (x.origin ?? "self") === origin);
                      if (list.length === 0) return null;
                      return (
                        <div key={origin} style={{ minWidth: 0 }}>
                          <div className="loki-label" style={{ fontSize: 9.5, padding: "2px 8px" }}>{origin} · {list.length}</div>
                          {list.map((x) => {
                            const on = shownSkill?.name === x.name;
                            return (
                              <Row dense key={x.name} selected={on} onClick={() => setSkillName(x.name)} title={x.description ?? x.name} style={{ justifyContent: "space-between", gap: 8, fontSize: 13.5 }}>
                                <span style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--loki-mono)" }}>{x.name}</span>
                                {origin === "other" && (
                                  <span style={{ fontFamily: "var(--loki-mono)", fontSize: 10.5, color: x.source ? "var(--loki-muted)" : "var(--loki-accent)", flex: "0 1 auto", minWidth: 0, maxWidth: "50%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={x.source ? `from ${x.source.label}` : "source unknown"}>
                                    {x.source ? x.source.label : "source?"}
                                  </span>
                                )}
                              </Row>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ fontSize: 10.5, color: "var(--loki-muted)", padding: "14px 8px 0", lineHeight: 1.5 }}>Skills every agent reads are in Settings › skills.</div>
                </div>
                <div style={{ minWidth: 0, minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: "14px 28px 24px" }}>
                  {!viewSkill && <div style={{ fontSize: 12, color: "var(--loki-muted)" }}>{d.skills.length ? "pick a skill" : `${d.agent.name} has no skills in memory yet`}</div>}
                  {viewSkill && (
                    <>
                      <div className="loki-label" style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 9.5, marginBottom: 6 }}>
                        <span style={{ color: "var(--loki-fg)", letterSpacing: 0, fontFamily: "var(--loki-mono)", textTransform: "none" }}>{viewSkill.path}</span>
                        {loadingView && <span>loading…</span>}
                        <span style={{ flex: 1 }} />
                        {viewSkill.origin === "other" && (
                          <Button tone="brass" onClick={() => void refreshSkill(viewSkill).then((err) => err && flash(err))} disabled={refreshing === viewSkill.name} title={viewSkill.source ? `pull the latest from ${viewSkill.source.label} and reconcile with ${d.agent.name}'s copy` : "say where this skill came from, then pull the latest"}>
                            {refreshing === viewSkill.name ? "refreshing…" : "refresh"}
                          </Button>
                        )}
                        <Button tone="negative" onClick={() => void removeSkill(viewSkill)} title={`remove ${viewSkill.name} from ${d.agent.name}'s memory`}>
                          remove
                        </Button>
                      </div>
                      <div style={{ display: "grid", gap: 4, marginBottom: 14 }}>
                        <div style={{ fontSize: 10.5, fontFamily: "var(--loki-mono)", letterSpacing: "0.06em", color: viewSkill.origin === "other" && !viewSkill.source ? "var(--loki-accent)" : "var(--loki-muted)" }}>
                          {viewSkill.origin === "self" ? `written by ${d.agent.name}` : viewSkill.source ? `from ${viewSkill.source.label}` : "installed · source unknown"}
                          {viewSkill.origin === "other" && viewSkill.edited ? ` · edited by ${d.agent.name} since` : ""}
                        </div>
                        {viewSkill.description && <div style={{ fontSize: 13.5, color: "var(--loki-muted)", lineHeight: 1.5, maxWidth: 760 }}>{viewSkill.description}</div>}
                        {needsSource === viewSkill.name && <SourceAsk name={viewSkill.name} onGo={(src) => refreshSkill(viewSkill, src)} onCancel={() => setNeedsSource(null)} />}
                      </div>
                      {content === null && !loadingView && <div style={{ fontSize: 12, color: "var(--loki-muted)" }}>nothing to show here</div>}
                      {content !== null && (
                        <div className="loki-md" style={{ fontSize: 13.5, lineHeight: 1.6, color: "var(--loki-fg)", maxWidth: 760, overflowWrap: "anywhere" }}>
                          <Markdown remarkPlugins={[remarkGfm]}>{stripFrontmatter(content)}</Markdown>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** The form for a new agent: name, description, one of Letta's personality presets, a model. */
function NewAgent({ models, onLoadModels, onCreate, onCancel, canCancel }: { models: string[] | null; onLoadModels: () => void; onCreate: (opts: { personality: Personality; name: string; description?: string; model?: string }) => Promise<string | null>; onCancel: () => void; canCancel: boolean }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [personality, setPersonality] = useState<Personality>("memo");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(onLoadModels, []); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    const err = await onCreate({ personality, name: name.trim(), description: description.trim() || undefined, model: model.trim() || undefined });
    setBusy(false);
    if (err) setError(err);
  };
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "24px 28px" }} onKeyDown={(e) => e.key === "Enter" && void submit()}>
      <div style={{ maxWidth: 560, display: "grid", gap: 12 }}>
        <Title>a new agent</Title>
        <Labelled label="name"><Field autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="ira, friday, atlas…" autoComplete="off" data-1p-ignore data-form-type="other" /></Labelled>
        <Labelled label="description"><Field value={description} onChange={(e) => setDescription(e.target.value)} placeholder="what this agent is for (optional)" autoComplete="off" data-form-type="other" /></Labelled>
        <Labelled label="personality">
          <div role="radiogroup" style={{ display: "grid", gap: 4, width: "100%" }}>
            {PERSONALITIES.map((p) => (
              <Row dense key={p.id} role="radio" aria-checked={personality === p.id} selected={personality === p.id} onClick={() => setPersonality(p.id)} style={{ display: "grid", gridTemplateColumns: "90px 1fr", gap: 10 }}>
                <span style={{ fontSize: 13.5 }}>{p.label}</span>
                <span style={{ fontSize: 12, color: "var(--loki-muted)" }}>{p.description}</span>
              </Row>
            ))}
          </div>
        </Labelled>
        <Labelled label="model">
          <Field mono list="loki-new-agent-models" value={model} onChange={(e) => setModel(e.target.value)} placeholder={models?.length ? "the harness default, or pick one" : "the harness default"} autoComplete="off" data-form-type="other" />
          <datalist id="loki-new-agent-models">{(models ?? []).map((m) => <option key={m} value={m} />)}</datalist>
        </Labelled>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {error && <span style={{ fontSize: 12, color: "var(--loki-negative)", fontFamily: "var(--loki-mono)" }}>{error}</span>}
          <span style={{ flex: 1 }} />
          {canCancel && <Button onClick={onCancel}>cancel</Button>}
          <Button tone="brass" onClick={() => void submit()} disabled={busy || !name.trim()} kbd="↵">{busy ? "creating…" : "create"}</Button>
        </div>
      </div>
    </div>
  );
}

/** Add a skill to this agent: write one here, or install from a source the CLI knows. */
function SkillAdd({ mode, onWrite, onInstall, onClose, agentName }: { mode: "write" | "install"; onWrite: (name: string, markdown: string) => Promise<string | null>; onInstall: (source: string) => Promise<string | null>; onClose: () => void; agentName: string }) {
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const go = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const err = mode === "write" ? (slug && text.trim() ? await onWrite(slug, `---\nname: ${slug}\ndescription: ${text.trim().split("\n")[0].replace(/^#+\s*/, "").slice(0, 120)}\n---\n\n${text.trim()}\n`) : "a name and some text") : source.trim() ? await onInstall(source) : "a source";
    setBusy(false);
    if (err) return setError(err);
    onClose();
  };
  return (
    <div style={{ display: "grid", gap: 6, margin: "0 0 10px", padding: "8px 10px", border: "1px solid var(--loki-border)", borderRadius: 8 }}>
      {mode === "write" ? (
        <>
          <Field size="sm" mono autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="skill name (becomes skills/<name>/SKILL.md)" autoComplete="off" data-form-type="other" />
          <TextArea size="sm" value={text} onChange={(e) => setText(e.target.value)} rows={6} placeholder={`# When to use\n\nWhat ${agentName} should do, step by step. The first line becomes the description.`} style={{ lineHeight: 1.5 }} />
        </>
      ) : (
        <>
          <Field size="sm" mono autoFocus value={source} onChange={(e) => setSource(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void go()} placeholder="owner/repo/path · official/finance/stocks · clawhub/<slug> · a GitHub or SKILL.md URL" autoComplete="off" data-form-type="other" />
          <span style={{ fontSize: 10.5, color: "var(--loki-muted)" }}>runs <code style={{ fontFamily: "var(--loki-mono)" }}>letta install</code> for {agentName}; can take a minute</span>
        </>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {error && <span style={{ fontSize: 12, color: "var(--loki-negative)", fontFamily: "var(--loki-mono)" }}>{error}</span>}
        <span style={{ flex: 1 }} />
        <Button onClick={onClose}>cancel</Button>
        <Button tone="brass" onClick={() => void go()} disabled={busy}>{busy ? (mode === "install" ? "installing…" : "writing…") : mode === "install" ? "install" : "add"}</Button>
      </div>
    </div>
  );
}

/** Enable a global skill from a folder path. */
/** Where an installed skill came from, asked once: a GitHub URL or owner/repo/path, or a folder on this Mac. The mod remembers the answer. */
function SourceAsk({ name, onGo, onCancel }: { name: string; onGo: (source: string) => Promise<string | null>; onCancel: () => void }) {
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    if (busy || !source.trim()) return;
    setBusy(true);
    setError(null);
    const err = await onGo(source.trim());
    setBusy(false);
    if (err) setError(err);
  };
  return (
    <div style={{ display: "grid", gap: 6, padding: "8px 10px", border: "1px solid var(--loki-border)", borderRadius: 8 }}>
      <span style={{ fontSize: 12, color: "var(--loki-muted)", lineHeight: 1.4 }}>Nobody wrote down where {name} came from. Say once; it is remembered.</span>
      <Field size="sm" mono autoFocus value={source} onChange={(e) => setSource(e.target.value)} onKeyDown={(e) => (e.key === "Enter" ? void go() : e.key === "Escape" ? onCancel() : undefined)} placeholder="https://github.com/owner/repo/tree/main/skills/name · owner/repo/path · ~/a/folder" autoComplete="off" data-form-type="other" />
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {error && <span style={{ fontSize: 12, color: "var(--loki-negative)", fontFamily: "var(--loki-mono)" }}>{error}</span>}
        <span style={{ flex: 1 }} />
        <Button onClick={onCancel}>cancel</Button>
        <Button tone="brass" onClick={() => void go()} disabled={busy || !source.trim()}>{busy ? "refreshing…" : "refresh"}</Button>
      </div>
    </div>
  );
}

function Identity({ d, avatar, models, onLoadModels, onSave }: { d: AgentDetails; avatar: string; models: string[] | null; onLoadModels: () => void; onSave: (body: { name?: string; description?: string; model?: string }) => Promise<void> }) {
  const [name, setName] = useState(d.agent.name);
  const [description, setDescription] = useState(d.agent.description ?? "");
  const [model, setModel] = useState(d.agent.model ?? "");
  useEffect(() => {
    setName(d.agent.name);
    setDescription(d.agent.description ?? "");
    setModel(d.agent.model ?? "");
  }, [d]);
  const settings = d.agent.modelSettings;
  const bits = [settings.effort ? `effort ${String(settings.effort)}` : null, settings.thinking ? "thinking" : null, settings.context_window_limit ? `${contextSize(Number(settings.context_window_limit))} context` : null].filter(Boolean);
  return (
    <section style={{ display: "grid", gridTemplateColumns: "64px 1fr", gap: 14, alignItems: "start" }}>
      <AgentFace name={d.agent.name} src={avatar} size={64} />
      <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
        <Field
          inline
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name.trim() !== d.agent.name && void onSave({ name: name.trim() })}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          aria-label="agent name"
          style={{ fontFamily: "var(--loki-display)", fontSize: 22 }}
        />
        <Field
          inline
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => description.trim() !== (d.agent.description ?? "") && void onSave({ description: description.trim() })}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          placeholder="a line about this agent"
          aria-label="agent description"
          style={{ fontSize: 13.5, color: "var(--loki-muted)" }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, fontSize: 12, color: "var(--loki-muted)", fontFamily: "var(--loki-mono)", flexWrap: "wrap" }}>
          <Field
            inline
            mono
            list="loki-models"
            value={model}
            onFocus={onLoadModels}
            onChange={(e) => setModel(e.target.value)}
            onBlur={() => model.trim() && model.trim() !== (d.agent.model ?? "") && void onSave({ model: model.trim() })}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            aria-label="model"
            style={{ width: 240, fontSize: 12 }}
          />
          <datalist id="loki-models">{(models ?? []).map((m) => <option key={m} value={m} />)}</datalist>
          {bits.map((b) => (
            <span key={b}>· {b}</span>
          ))}
          {d.agent.favourite && <span style={{ color: "var(--loki-accent)" }}>· ★ favourite</span>}
        </div>
      </div>
    </section>
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

/** A unified diff, coloured by line; the header lines (message, date, stat) stay muted. */
export function Diff({ text }: { text: string }) {
  return (
    <pre style={{ margin: 0, fontFamily: "var(--loki-mono)", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
      {text.split("\n").map((line, i) => {
        const color = line.startsWith("+") && !line.startsWith("+++") ? "var(--loki-positive)" : line.startsWith("-") && !line.startsWith("---") ? "var(--loki-negative)" : line.startsWith("@@") ? "var(--loki-accent)" : line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("+++") || line.startsWith("---") ? "var(--loki-muted)" : "var(--loki-fg)";
        return (
          <div key={i} style={{ color }}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

function Head({ children }: { children: React.ReactNode }) {
  return (
    <div className="loki-label" style={{ display: "flex", alignItems: "baseline", fontSize: 9.5, padding: "0 8px 6px" }}>
      {children}
    </div>
  );
}

/** A labelled line in the new-agent form: the label in the head's voice, the control beside it. */
function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 8px" }}>
      <span className="loki-label" style={{ fontSize: 9.5, width: 44 }}>{label}</span>
      {children}
    </div>
  );
}

/** A context window as people say it: 200k, 1M. */
function contextSize(tokens: number): string {
  return tokens >= 1_000_000 ? `${Math.round(tokens / 100_000) / 10}M` : `${Math.round(tokens / 1000)}k`;
}
