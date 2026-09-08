import { useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { LocalAgent, MemoryCommit, MemoryFile, MemorySkill } from "../../../mod/agents.ts";
import type { GlobalSkill } from "../../../mod/skills.ts";
import { PERSONALITIES, type Personality } from "../../../packages/core/src/attention/protocol.ts";
import type { DeskSummary } from "../desk/useDesk";
import { AgentFace } from "../desk/AgentChip";
import { btn, kbd } from "../chat/ui";
import type { Task } from "../board/model";
import { ago } from "../board/model";

export interface AgentDetails {
  agent: LocalAgent;
  files: MemoryFile[];
  skills: MemorySkill[];
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
              <button onClick={() => setConfirmDelete(true)} style={{ ...btn(), justifySelf: "start", color: "var(--loki-muted)", fontSize: 10.5 }}>delete this agent…</button>
            )}

            <section>
              <Head>memory{d.lastCommit ? <span style={{ marginLeft: "auto", letterSpacing: 0, fontFamily: "var(--loki-mono)" }}>last change {ago(d.lastCommit.at)}</span> : null}</Head>
              <Tree files={d.files.filter((f) => !f.path.startsWith("skills/") && f.path !== "profile.png")} current={view?.kind === "file" ? view.path : null} onPick={(p) => setView({ kind: "file", path: p })} />
            </section>

            <section>
              <Head>skills <span style={{ marginLeft: "auto", letterSpacing: 0, fontFamily: "var(--loki-mono)" }}>{d.skills.length || ""}</span></Head>
              {d.skills.length === 0 && <div style={{ fontSize: 12, color: "var(--loki-muted)" }}>none in memory</div>}
              <div style={{ display: "grid", gap: 4 }}>
                {d.skills.map((s) => (
                  <div key={s.name} className="loki-tree-row" style={{ display: "grid", gridTemplateColumns: "1fr auto", alignItems: "start", borderRadius: 6, background: view?.kind === "file" && view.path === s.path ? "var(--loki-accent-soft)" : "transparent" }}>
                    <button onClick={() => setView({ kind: "file", path: s.path })} style={{ display: "grid", gap: 2, textAlign: "left", padding: "6px 8px", border: "none", background: "transparent", color: "var(--loki-fg)", cursor: "pointer", font: "inherit", minWidth: 0 }}>
                      <span style={{ fontSize: 13.5, fontFamily: "var(--loki-mono)" }}>{s.name}</span>
                      {s.description && <span style={{ fontSize: 12, color: "var(--loki-muted)", lineHeight: 1.4 }}>{s.description}</span>}
                    </button>
                    <button onClick={() => void removeSkill(s)} title={`remove ${s.name} from ${d.agent.name}'s memory`} aria-label={`remove ${s.name}`} style={{ ...btn(), padding: "3px 7px", margin: "5px 6px 0 0", fontSize: 10.5 }}>remove</button>
                  </div>
                ))}
              </div>
              <SkillAdd onWrite={addSkill} onInstall={installSkill} agentName={d.agent.name} />
            </section>

            <section>
              <Head>global skills <span style={{ marginLeft: "auto", letterSpacing: 0, fontFamily: "var(--loki-mono)" }}>{globalSkills?.length || ""}</span></Head>
              <div style={{ fontSize: 12, color: "var(--loki-muted)", marginBottom: 6, lineHeight: 1.4 }}>~/.letta/skills — every agent reads these; each entry links to a folder holding a SKILL.md</div>
              {globalSkills === null && <div style={{ fontSize: 12, color: "var(--loki-muted)" }}>reading…</div>}
              {globalSkills?.length === 0 && <div style={{ fontSize: 12, color: "var(--loki-muted)" }}>none</div>}
              <div style={{ display: "grid", gap: 4 }}>
                {(globalSkills ?? []).map((g) => (
                  <div key={g.name} className="loki-tree-row" style={{ display: "grid", gridTemplateColumns: "1fr auto", alignItems: "start", padding: "4px 0 4px 8px", borderRadius: 6 }}>
                    <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
                      <span style={{ fontSize: 13.5, fontFamily: "var(--loki-mono)" }}>{g.name}</span>
                      <span style={{ fontSize: 12, color: "var(--loki-muted)", lineHeight: 1.4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={g.path}>{g.description ?? g.path}</span>
                    </span>
                    <button onClick={() => void write.disableSkill(g.name).then((err) => (err ? flash(err) : (flash(`${g.name} disabled`), loadGlobal())))} style={{ ...btn(), padding: "3px 7px", margin: "1px 6px 0 0", fontSize: 10.5 }}>disable</button>
                  </div>
                ))}
              </div>
              <PathAdd onAdd={(path) => write.enableSkill(path).then((err) => (err ? err : (flash("enabled"), loadGlobal(), null)))} />
            </section>

            <section>
              <Head>where</Head>
              <div style={{ display: "grid", gap: 6, fontSize: 13.5 }}>
                <Row label="desks">
                  <span>{myDesks.length} live</span>
                  <button onClick={onShowDesks} style={btn()}>open the tree <kbd style={kbd}>⌘K</kbd></button>
                  <button onClick={() => onOpenDesk(selected, "default")} style={btn()}>main chat</button>
                </Row>
                <Row label="tasks">
                  <span>{myTasks.length} assigned</span>
                  <button onClick={onShowBoard} style={btn()}>board <kbd style={kbd}>⌘3</kbd></button>
                </Row>
              </div>
            </section>
          </div>

          {/* right: the file or the diff, and the history */}
          <div style={{ minWidth: 0, display: "grid", gridTemplateRows: "minmax(0, 1fr) auto", overflow: "hidden" }}>
            <div style={{ minHeight: 0, overflowY: "auto", padding: "18px 28px 24px" }}>
              {view && (
                <div className="loki-label" style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 9.5, marginBottom: 12 }}>
                  <span style={{ color: "var(--loki-fg)", letterSpacing: 0, fontFamily: "var(--loki-mono)", textTransform: "none" }}>{view.kind === "file" ? view.path : `commit ${view.sha.slice(0, 8)}`}</span>
                  {loadingView && <span>loading…</span>}
                  <span style={{ flex: 1 }} />
                  {view.kind === "file" && (
                    <button onClick={() => onAskToUpdate(selected, `In your memory file \`${view.path}\`, please update: `)} style={btn("var(--loki-accent)")} title="opens the agent's main chat with the request started">
                      ask {d.agent.name} to update this
                    </button>
                  )}
                </div>
              )}
              {content === null && !loadingView && <div style={{ fontSize: 12, color: "var(--loki-muted)" }}>nothing to show here (binary, too large, or gone)</div>}
              {content !== null && view?.kind === "file" && (
                <div className="loki-chat" style={{ fontSize: 13.5, lineHeight: 1.6, color: "var(--loki-fg)", maxWidth: 760 }}>
                  <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
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
function SkillAdd({ onWrite, onInstall, agentName }: { onWrite: (name: string, markdown: string) => Promise<string | null>; onInstall: (source: string) => Promise<string | null>; agentName: string }) {
  const [mode, setMode] = useState<null | "write" | "install">(null);
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
    setMode(null);
    setName("");
    setText("");
    setSource("");
  };
  const field: React.CSSProperties = { width: "100%", boxSizing: "border-box", padding: "6px 10px", fontSize: 12, background: "var(--loki-well)", border: "1px solid var(--loki-border)", borderRadius: 6, color: "var(--loki-fg)", outline: "none" };
  if (!mode) {
    return (
      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
        <button onClick={() => setMode("write")} style={btn()}>write a skill</button>
        <button onClick={() => setMode("install")} style={btn()}>install…</button>
      </div>
    );
  }
  return (
    <div style={{ display: "grid", gap: 6, marginTop: 8, padding: "8px 10px", border: "1px solid var(--loki-border)", borderRadius: 8 }}>
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
        <button onClick={() => setMode(null)} style={btn()}>cancel</button>
        <button onClick={() => void go()} disabled={busy} style={{ ...btn("var(--loki-accent)"), opacity: busy ? 0.5 : 1 }}>{busy ? (mode === "install" ? "installing…" : "writing…") : mode === "install" ? "install" : "add"}</button>
      </div>
    </div>
  );
}

/** Enable a global skill from a folder path. */
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
        {d.agent.systemHead && <div style={{ fontSize: 10.5, color: "var(--loki-muted)", marginTop: 6, lineHeight: 1.45 }}>system prompt (Letta Code's): {d.agent.systemHead}</div>}
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
