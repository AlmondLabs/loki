import { useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { LocalAgent, MemoryCommit, MemoryFile, MemorySkill } from "../../../mod/agents.ts";
import type { GlobalSkill } from "../../../mod/skills.ts";
import type { MemorySkillInfo, RefreshOutcome } from "../../../mod/skill-sources.ts";
import { PERSONALITIES, type Personality } from "../../../packages/core/src/attention/protocol.ts";
import type { DeskSummary } from "../desk/useDesk";
import { AgentFace } from "../desk/AgentChip";
import { btn, kbd } from "../chat/ui";
import type { Task } from "../board/model";
import { ago } from "../board/model";
import { stripFrontmatter } from "../phone/model";

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
  enableSkill: (path: string) => Promise<string | null>;
  disableSkill: (name: string) => Promise<string | null>;
}

/**
 * The Agents page: one tab per agent — its face, name, description and model (editable through the
 * app-server), its memory as a browsable tree with the git history of what it learned, its skills,
 * and where it is working (desks, tasks). Memory is read-only here: to change a fact you hand the
 * request to the agent in its own chat.
 */
/** A small action in a section head: the head's own label style, clickable. */
const headBtn: React.CSSProperties = { background: "transparent", border: "none", padding: 0, cursor: "pointer", color: "inherit", font: "inherit" };

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
  const [view, setView] = useState<{ kind: "file"; path: string } | { kind: "commit"; sha: string } | null>(null);
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
    setView({ kind: "file", path: "system/persona.md" });
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
  /** The skill the right pane is showing, when the open file is a skill's SKILL.md. */
  const viewSkill = view?.kind === "file" && d ? d.skills.find((s) => s.path === view.path) ?? null : null;
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
  const [showGlobal, setShowGlobal] = useState(false);
  const [globalSkills, setGlobalSkills] = useState<GlobalSkill[] | null>(null);
  const loadGlobal = () => void api.globalSkills().then(setGlobalSkills);
  useEffect(loadGlobal, []); // eslint-disable-line react-hooks/exhaustive-deps
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
    setView({ kind: "file", path });
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
      <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", gap: 12, alignContent: "center", color: "var(--loki-muted)", fontSize: 13.5 }}>
        <span>No agents yet.</span>
        <button onClick={() => setCreating(true)} style={btn("var(--loki-accent)")}>new agent</button>
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
            style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "8px 14px 10px", border: "none", borderBottom: `2px solid ${a.id === selected ? "var(--loki-accent)" : "transparent"}`, background: "transparent", color: a.id === selected ? "var(--loki-fg)" : "var(--loki-muted)", cursor: "pointer", font: "inherit", fontFamily: "var(--loki-display)", fontSize: 15 }}
          >
            <AgentFace name={a.name} src={avatar(a.id)} size={22} />
            {a.name}
          </button>
        ))}
        <button role="tab" aria-selected={creating} onClick={() => setCreating(true)} title="a new agent" style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 12px 10px", border: "none", borderBottom: `2px solid ${creating ? "var(--loki-accent)" : "transparent"}`, background: "transparent", color: creating ? "var(--loki-fg)" : "var(--loki-muted)", cursor: "pointer", font: "inherit", fontFamily: "var(--loki-display)", fontSize: 15 }}>
          + new
        </button>
        <span style={{ flex: 1 }} />
        {notice && <span style={{ alignSelf: "center", fontSize: 12, color: "var(--loki-accent)" }}>{notice}</span>}
      </div>

      {creating && <NewAgent models={models} onLoadModels={() => void listModels().then((m) => setModels(m.map((e) => e.handle)))} onCreate={created} onCancel={() => setCreating(false)} canCancel={agents.length > 0} />}

      {!creating && selected && d === undefined && <Empty text="reading the agent…" />}
      {!creating && selected && d === null && <Empty text="This agent has no local record on this machine (a remote or hidden agent)." />}
      {!creating && selected && d && (
        <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "minmax(300px, 380px) 1fr", gap: 0 }}>
          {/* left: identity, memory tree, skills, where */}
          <div style={{ overflowY: "auto", padding: "18px 20px 24px 24px", borderRight: "1px solid var(--loki-border)", display: "grid", gap: 22, alignContent: "start" }}>
            <Identity d={d} avatar={avatar(selected)} models={models} onLoadModels={() => void listModels().then((m) => setModels(m.map((e) => e.handle)))} onSave={save} />
            {/* where it is working: a line, not a section */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12, color: "var(--loki-muted)", padding: "0 8px" }}>
              <span>{myDesks.length} desk{myDesks.length === 1 ? "" : "s"} live · {myTasks.length} task{myTasks.length === 1 ? "" : "s"}</span>
              <span style={{ flex: 1 }} />
              <button onClick={() => onOpenDesk(selected, "default")} style={{ ...btn(), padding: "2px 8px", fontSize: 10.5 }}>main chat</button>
              <button onClick={onShowDesks} title="the desk tree (⌘K)" style={{ ...btn(), padding: "2px 8px", fontSize: 10.5 }}>desks</button>
              <button onClick={onShowBoard} title="the board (⌘3)" style={{ ...btn(), padding: "2px 8px", fontSize: 10.5 }}>board</button>
            </div>

            <section>
              <Head>memory{d.lastCommit ? <span style={{ marginLeft: "auto", letterSpacing: 0, fontFamily: "var(--loki-mono)" }}>last change {ago(d.lastCommit.at)}</span> : null}</Head>
              <Tree files={d.files.filter((f) => !f.path.startsWith("skills/") && f.path !== "profile.png")} current={view?.kind === "file" ? view.path : null} onPick={(p) => setView({ kind: "file", path: p })} />
            </section>

            {/* One line per skill, in two groups. Self: the agent (or you) wrote it. Other: installed from somewhere,
                named on the right. Pick a row and the skill opens on the right, with refresh and remove up there. */}
            <section>
              <Head>
                skills
                <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8 }}>
                  <button className="loki-label" onClick={() => setAdding(adding === "write" ? null : "write")} aria-pressed={adding === "write"} style={{ ...headBtn, color: adding === "write" ? "var(--loki-accent)" : undefined }}>write</button>
                  <button className="loki-label" onClick={() => setAdding(adding === "install" ? null : "install")} aria-pressed={adding === "install"} style={{ ...headBtn, color: adding === "install" ? "var(--loki-accent)" : undefined }}>install</button>
                </span>
              </Head>
              {adding && <SkillAdd key={adding} mode={adding} onWrite={addSkill} onInstall={installSkill} onClose={() => setAdding(null)} agentName={d.agent.name} />}
              {d.skills.length === 0 && !adding && <div style={{ fontSize: 12, color: "var(--loki-muted)", padding: "0 8px" }}>none in memory</div>}
              <div style={{ display: "grid", gap: 8 }}>
                {(["self", "other"] as const).map((origin) => {
                  const list = d.skills.filter((s) => (s.origin ?? "self") === origin);
                  if (list.length === 0) return null;
                  return (
                    <div key={origin}>
                      <div className="loki-label" style={{ fontSize: 9.5, padding: "2px 8px" }}>{origin === "self" ? `self · ${list.length}` : `other · ${list.length}`}</div>
                      {list.map((s) => {
                        const on = view?.kind === "file" && view.path === s.path;
                        return (
                          <button key={s.name} onClick={() => setView({ kind: "file", path: s.path })} title={s.description ?? s.name} style={{ display: "flex", justifyContent: "space-between", gap: 8, width: "100%", textAlign: "left", padding: "4px 8px", border: "none", borderRadius: 6, background: on ? "var(--loki-accent-soft)" : "transparent", color: "var(--loki-fg)", cursor: "pointer", font: "inherit", fontSize: 13.5 }}>
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--loki-mono)" }}>{s.name}</span>
                            {origin === "other" && (
                              <span style={{ fontFamily: "var(--loki-mono)", fontSize: 10.5, color: s.source ? "var(--loki-muted)" : "var(--loki-accent)", flex: "0 0 auto", maxWidth: "45%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.source ? `from ${s.source.label}` : "source unknown"}>
                                {s.source ? s.source.label : "source?"}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Every agent reads these; they are not this agent's, so they stay folded until asked for. */}
            <section>
              <Head>
                <button className="loki-label" onClick={() => setShowGlobal((v) => !v)} aria-expanded={showGlobal} style={{ ...headBtn, display: "inline-flex", gap: 6, alignItems: "baseline" }}>
                  <span aria-hidden style={{ display: "inline-block", width: 8, transform: showGlobal ? "rotate(90deg)" : "none", transition: "transform 120ms ease-out" }}>▸</span>
                  global skills
                </button>
                <span style={{ marginLeft: "auto", letterSpacing: 0, fontFamily: "var(--loki-mono)" }}>{globalSkills?.length || ""}</span>
              </Head>
              {showGlobal && (
                <>
                  <div style={{ fontSize: 12, color: "var(--loki-muted)", margin: "0 8px 6px", lineHeight: 1.4 }}>~/.letta/skills — every agent reads these</div>
                  {globalSkills === null && <div style={{ fontSize: 12, color: "var(--loki-muted)", padding: "0 8px" }}>reading…</div>}
                  {globalSkills?.length === 0 && <div style={{ fontSize: 12, color: "var(--loki-muted)", padding: "0 8px" }}>none</div>}
                  <div style={{ display: "grid", gap: 2 }}>
                    {(globalSkills ?? []).map((g) => (
                      <div key={g.name} className="loki-tree-row" style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 0 2px 8px", borderRadius: 6 }} title={g.description ?? g.path}>
                        <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontFamily: "var(--loki-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.name}</span>
                        {g.isLink && <span style={{ fontSize: 9.5, color: "var(--loki-muted)", fontFamily: "var(--loki-mono)" }}>link</span>}
                        <button onClick={() => void write.disableSkill(g.name).then((err) => (err ? flash(err) : (flash(`${g.name} disabled`), loadGlobal())))} style={{ ...btn(), padding: "2px 7px", marginRight: 6, fontSize: 10.5 }}>disable</button>
                      </div>
                    ))}
                  </div>
                  <PathAdd onAdd={(path) => write.enableSkill(path).then((err) => (err ? err : (flash("enabled"), loadGlobal(), null)))} />
                </>
              )}
            </section>

            <div style={{ paddingTop: 8 }}>
              {confirmDelete ? (
                <div role="alertdialog" aria-label={`delete ${d.agent.name}`} style={{ display: "grid", gap: 8, padding: "10px 12px", border: "1px solid var(--loki-negative)", borderRadius: 8, fontSize: 12, color: "var(--loki-fg)", lineHeight: 1.5 }}>
                  <span>
                  Delete <b>{d.agent.name}</b> and its memory. {myDesks.length ? `${myDesks.length} live desk${myDesks.length === 1 ? "" : "s"} (${myDesks.slice(0, 3).map((x) => x.title ?? "main chat").join(", ")}${myDesks.length > 3 ? "…" : ""}) go with it.` : "It has no live desks."}
                  {myTasks.length ? ` ${myTasks.length} open task${myTasks.length === 1 ? "" : "s"} stay on the board, unassigned.` : ""}
                </span>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => void remove()} style={btn("var(--loki-negative)")}>delete {d.agent.name}</button>
                    <button onClick={() => setConfirmDelete(false)} style={btn()}>keep</button>
                  </div>
                </div>
              ) : (
                <button onClick={() => setConfirmDelete(true)} style={{ ...btn(), color: "var(--loki-muted)", fontSize: 10.5 }}>delete this agent…</button>
              )}
            </div>
          </div>

          {/* right: the file or the diff, and the history */}
          <div style={{ minWidth: 0, display: "grid", gridTemplateRows: "minmax(0, 1fr) auto", overflow: "hidden" }}>
            <div style={{ minHeight: 0, overflowY: "auto", padding: "18px 28px 24px" }}>
              {view && (
                <div className="loki-label" style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 9.5, marginBottom: viewSkill ? 6 : 12 }}>
                  <span style={{ color: "var(--loki-fg)", letterSpacing: 0, fontFamily: "var(--loki-mono)", textTransform: "none" }}>{view.kind === "file" ? view.path : `commit ${view.sha.slice(0, 8)}`}</span>
                  {loadingView && <span>loading…</span>}
                  <span style={{ flex: 1 }} />
                  {viewSkill && viewSkill.origin === "other" && (
                    <button onClick={() => void refreshSkill(viewSkill).then((err) => err && flash(err))} disabled={refreshing === viewSkill.name} title={viewSkill.source ? `pull the latest from ${viewSkill.source.label} and reconcile with ${d.agent.name}'s copy` : "say where this skill came from, then pull the latest"} style={{ ...btn("var(--loki-accent)"), opacity: refreshing === viewSkill.name ? 0.5 : 1 }}>
                      {refreshing === viewSkill.name ? "refreshing…" : "refresh"}
                    </button>
                  )}
                  {viewSkill && (
                    <button onClick={() => void removeSkill(viewSkill)} title={`remove ${viewSkill.name} from ${d.agent.name}'s memory`} style={btn()}>
                      remove
                    </button>
                  )}
                  {view.kind === "file" && !viewSkill && (
                    <button onClick={() => onAskToUpdate(selected, `In your memory file \`${view.path}\`, please update: `)} style={btn("var(--loki-accent)")} title="opens the agent's main chat with the request started">
                      ask {d.agent.name} to update this
                    </button>
                  )}
                </div>
              )}
              {viewSkill && (
                <div style={{ display: "grid", gap: 4, marginBottom: 14 }}>
                  <div style={{ fontSize: 10.5, fontFamily: "var(--loki-mono)", letterSpacing: "0.06em", color: viewSkill.origin === "other" && !viewSkill.source ? "var(--loki-accent)" : "var(--loki-muted)" }}>
                    {viewSkill.origin === "self" ? `written by ${d.agent.name}` : viewSkill.source ? `from ${viewSkill.source.label}` : "installed · source unknown"}
                    {viewSkill.origin === "other" && viewSkill.edited ? ` · edited by ${d.agent.name} since` : ""}
                  </div>
                  {viewSkill.description && <div style={{ fontSize: 13.5, color: "var(--loki-muted)", lineHeight: 1.5, maxWidth: 760 }}>{viewSkill.description}</div>}
                  {needsSource === viewSkill.name && <SourceAsk name={viewSkill.name} onGo={(src) => refreshSkill(viewSkill, src)} onCancel={() => setNeedsSource(null)} />}
                </div>
              )}
              {content === null && !loadingView && <div style={{ fontSize: 12, color: "var(--loki-muted)" }}>nothing to show here (binary, too large, or gone)</div>}
              {content !== null && view?.kind === "file" && (
                <div className="loki-chat" style={{ fontSize: 13.5, lineHeight: 1.6, color: "var(--loki-fg)", maxWidth: 760 }}>
                  <Markdown remarkPlugins={[remarkGfm]}>{viewSkill ? stripFrontmatter(content) : content}</Markdown>
                </div>
              )}
              {content !== null && view?.kind === "commit" && <Diff text={content} />}
            </div>
            <div style={{ borderTop: "1px solid var(--loki-border)", maxHeight: 220, overflowY: "auto", padding: "10px 28px 14px" }}>
              <Head>learned recently</Head>
              {log.length === 0 && <div style={{ fontSize: 12, color: "var(--loki-muted)" }}>no memory commits yet</div>}
              <div style={{ display: "grid", gap: 2 }}>
                {log.map((c) => (
                  <button key={c.sha} onClick={() => setView({ kind: "commit", sha: c.sha })} style={{ display: "grid", gridTemplateColumns: "56px 1fr auto", gap: 10, alignItems: "baseline", textAlign: "left", padding: "4px 8px", border: "none", borderRadius: 6, background: view?.kind === "commit" && view.sha === c.sha ? "var(--loki-accent-soft)" : "transparent", color: "var(--loki-fg)", cursor: "pointer", font: "inherit", fontSize: 12 }}>
                    <span style={{ fontFamily: "var(--loki-mono)", fontSize: 10.5, color: "var(--loki-muted)" }}>{ago(c.at)}</span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.message}</span>
                    <span style={{ fontFamily: "var(--loki-mono)", fontSize: 10.5, color: "var(--loki-muted)", whiteSpace: "nowrap" }}>{c.files.length === 1 ? c.files[0].split("/").pop() : `${c.files.length} files`}</span>
                  </button>
                ))}
              </div>
            </div>
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
  const field: React.CSSProperties = { width: "100%", boxSizing: "border-box", padding: "7px 10px", fontSize: 13.5, background: "var(--loki-well)", border: "1px solid var(--loki-border)", borderRadius: 6, color: "var(--loki-fg)", outline: "none" };
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "24px 28px" }} onKeyDown={(e) => e.key === "Enter" && void submit()}>
      <div style={{ maxWidth: 560, display: "grid", gap: 12 }}>
        <div style={{ fontFamily: "var(--loki-display)", fontSize: 17, color: "var(--loki-fg)" }}>a new agent</div>
        <Row label="name"><input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="ira, friday, atlas…" autoComplete="off" data-1p-ignore data-form-type="other" style={field} /></Row>
        <Row label="description"><input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="what this agent is for (optional)" autoComplete="off" data-form-type="other" style={field} /></Row>
        <Row label="personality">
          <div role="radiogroup" style={{ display: "grid", gap: 4, width: "100%" }}>
            {PERSONALITIES.map((p) => (
              <button key={p.id} type="button" role="radio" aria-checked={personality === p.id} onClick={() => setPersonality(p.id)} style={{ display: "grid", gridTemplateColumns: "90px 1fr", gap: 10, textAlign: "left", padding: "6px 10px", border: `1px solid ${personality === p.id ? "var(--loki-accent)" : "var(--loki-border)"}`, borderRadius: 6, background: personality === p.id ? "var(--loki-brass-soft)" : "transparent", color: "var(--loki-fg)", cursor: "pointer", font: "inherit" }}>
                <span style={{ fontSize: 13.5, color: personality === p.id ? "var(--loki-accent)" : "var(--loki-fg)" }}>{p.label}</span>
                <span style={{ fontSize: 12, color: "var(--loki-muted)" }}>{p.description}</span>
              </button>
            ))}
          </div>
        </Row>
        <Row label="model">
          <input list="loki-new-agent-models" value={model} onChange={(e) => setModel(e.target.value)} placeholder={models?.length ? "the harness default, or pick one" : "the harness default"} autoComplete="off" data-form-type="other" style={{ ...field, fontFamily: "var(--loki-mono)" }} />
          <datalist id="loki-new-agent-models">{(models ?? []).map((m) => <option key={m} value={m} />)}</datalist>
        </Row>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {error && <span style={{ fontSize: 12, color: "var(--loki-negative)", fontFamily: "var(--loki-mono)" }}>{error}</span>}
          <span style={{ flex: 1 }} />
          {canCancel && <button onClick={onCancel} style={btn()}>cancel</button>}
          <button onClick={() => void submit()} disabled={busy || !name.trim()} style={{ ...btn("var(--loki-accent)"), opacity: busy || !name.trim() ? 0.5 : 1 }}>{busy ? "creating…" : "create"} <kbd style={kbd}>↵</kbd></button>
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
  const field: React.CSSProperties = { width: "100%", boxSizing: "border-box", padding: "6px 10px", fontSize: 12, background: "var(--loki-well)", border: "1px solid var(--loki-border)", borderRadius: 6, color: "var(--loki-fg)", outline: "none" };
  return (
    <div style={{ display: "grid", gap: 6, margin: "0 0 10px", padding: "8px 10px", border: "1px solid var(--loki-border)", borderRadius: 8 }}>
      {mode === "write" ? (
        <>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="skill name (becomes skills/<name>/SKILL.md)" autoComplete="off" data-form-type="other" style={{ ...field, fontFamily: "var(--loki-mono)" }} />
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} placeholder={`# When to use\n\nWhat ${agentName} should do, step by step. The first line becomes the description.`} style={{ ...field, resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }} />
        </>
      ) : (
        <>
          <input autoFocus value={source} onChange={(e) => setSource(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void go()} placeholder="owner/repo/path · official/finance/stocks · clawhub/<slug> · a GitHub or SKILL.md URL" autoComplete="off" data-form-type="other" style={{ ...field, fontFamily: "var(--loki-mono)" }} />
          <span style={{ fontSize: 10.5, color: "var(--loki-muted)" }}>runs <code style={{ fontFamily: "var(--loki-mono)" }}>letta install</code> for {agentName}; can take a minute</span>
        </>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {error && <span style={{ fontSize: 12, color: "var(--loki-negative)", fontFamily: "var(--loki-mono)" }}>{error}</span>}
        <span style={{ flex: 1 }} />
        <button onClick={onClose} style={btn()}>cancel</button>
        <button onClick={() => void go()} disabled={busy} style={{ ...btn("var(--loki-accent)"), opacity: busy ? 0.5 : 1 }}>{busy ? (mode === "install" ? "installing…" : "writing…") : mode === "install" ? "install" : "add"}</button>
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
      <input autoFocus value={source} onChange={(e) => setSource(e.target.value)} onKeyDown={(e) => (e.key === "Enter" ? void go() : e.key === "Escape" ? onCancel() : undefined)} placeholder="https://github.com/owner/repo/tree/main/skills/name · owner/repo/path · ~/a/folder" autoComplete="off" data-form-type="other" style={{ width: "100%", boxSizing: "border-box", padding: "6px 10px", fontSize: 12, background: "var(--loki-well)", border: "1px solid var(--loki-border)", borderRadius: 6, color: "var(--loki-fg)", outline: "none", fontFamily: "var(--loki-mono)" }} />
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {error && <span style={{ fontSize: 12, color: "var(--loki-negative)", fontFamily: "var(--loki-mono)" }}>{error}</span>}
        <span style={{ flex: 1 }} />
        <button onClick={onCancel} style={btn()}>cancel</button>
        <button onClick={() => void go()} disabled={busy || !source.trim()} style={{ ...btn("var(--loki-accent)"), opacity: busy || !source.trim() ? 0.5 : 1 }}>{busy ? "refreshing…" : "refresh"}</button>
      </div>
    </div>
  );
}

function PathAdd({ onAdd }: { onAdd: (path: string) => Promise<string | null> }) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    if (busy || !path.trim()) return;
    setBusy(true);
    setError(null);
    const err = await onAdd(path.trim().replace(/^~(?=\/|$)/, "$HOME"));
    setBusy(false);
    if (err) return setError(err);
    setOpen(false);
    setPath("");
  };
  if (!open) return <button onClick={() => setOpen(true)} style={{ ...btn(), marginTop: 8, justifySelf: "start" }}>enable a folder…</button>;
  return (
    <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
      <input autoFocus value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void go()} placeholder="/absolute/path/to/a/folder/with/SKILL.md" autoComplete="off" data-form-type="other" style={{ width: "100%", boxSizing: "border-box", padding: "6px 10px", fontSize: 12, fontFamily: "var(--loki-mono)", background: "var(--loki-well)", border: "1px solid var(--loki-border)", borderRadius: 6, color: "var(--loki-fg)", outline: "none" }} />
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {error && <span style={{ fontSize: 12, color: "var(--loki-negative)", fontFamily: "var(--loki-mono)" }}>{error}</span>}
        <span style={{ flex: 1 }} />
        <button onClick={() => setOpen(false)} style={btn()}>cancel</button>
        <button onClick={() => void go()} disabled={busy || !path.trim()} style={{ ...btn("var(--loki-accent)"), opacity: busy || !path.trim() ? 0.5 : 1 }}>enable</button>
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
  const bits = [settings.effort ? `effort ${String(settings.effort)}` : null, settings.thinking ? "thinking" : null, settings.context_window_limit ? `${Math.round(Number(settings.context_window_limit) / 1000)}k context` : null].filter(Boolean);
  const field: React.CSSProperties = { background: "transparent", border: "1px solid transparent", borderRadius: 6, color: "var(--loki-fg)", padding: "2px 6px", margin: "0 -6px", font: "inherit", outline: "none", width: "100%", boxSizing: "content-box" };
  return (
    <section style={{ display: "grid", gridTemplateColumns: "64px 1fr", gap: 14, alignItems: "start" }}>
      <AgentFace name={d.agent.name} src={avatar} size={64} />
      <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name.trim() !== d.agent.name && void onSave({ name: name.trim() })}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          aria-label="agent name"
          className="loki-field"
          style={{ ...field, fontFamily: "var(--loki-display)", fontSize: 22 }}
        />
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => description.trim() !== (d.agent.description ?? "") && void onSave({ description: description.trim() })}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          placeholder="a line about this agent"
          aria-label="agent description"
          className="loki-field"
          style={{ ...field, fontSize: 13.5, color: "var(--loki-muted)" }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, fontSize: 12, color: "var(--loki-muted)", fontFamily: "var(--loki-mono)", flexWrap: "wrap" }}>
          <input
            list="loki-models"
            value={model}
            onFocus={onLoadModels}
            onChange={(e) => setModel(e.target.value)}
            onBlur={() => model.trim() && model.trim() !== (d.agent.model ?? "") && void onSave({ model: model.trim() })}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            aria-label="model"
            className="loki-field"
            style={{ ...field, width: 240, fontSize: 12, fontFamily: "var(--loki-mono)", color: "var(--loki-fg)" }}
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
    <div style={{ display: "grid", gap: 8 }}>
      {groups.map(([g, fs]) => (
        <div key={g || "root"}>
          {g && <div className="loki-label" style={{ fontSize: 9.5, padding: "2px 8px" }}>{g}</div>}
          {fs.map((f) => (
            <button key={f.path} onClick={() => onPick(f.path)} title={`${f.bytes} bytes · ${ago(f.modifiedAt)}`} style={{ display: "flex", justifyContent: "space-between", gap: 8, width: "100%", textAlign: "left", padding: "4px 8px", border: "none", borderRadius: 6, background: current === f.path ? "var(--loki-accent-soft)" : "transparent", color: "var(--loki-fg)", cursor: "pointer", font: "inherit", fontSize: 12 }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g ? f.path.slice(g.length + 1) : f.path}</span>
              <span style={{ fontFamily: "var(--loki-mono)", fontSize: 10.5, color: "var(--loki-muted)", flex: "0 0 auto" }}>{ago(f.modifiedAt)}</span>
            </button>
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

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 8px" }}>
      <span className="loki-label" style={{ fontSize: 9.5, width: 44 }}>{label}</span>
      {children}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div style={{ flex: 1, display: "grid", placeItems: "center", color: "var(--loki-muted)", fontSize: 13.5 }}>
      {text}
    </div>
  );
}
