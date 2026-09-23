import { useState } from "react";
import type { MemorySkillInfo } from "../../../mod/skill-sources.ts";
import { Button, Chip, Field, Row, TextArea, sentence } from "../components";
import { Head, ListPane, Pane, Prose } from "./bits";
import type { AgentDetails } from "./types";
import type { AgentStore } from "./useAgentDetails";
import type { ReadingState } from "./useReading";

/** The skills page's add form: write one here, or install from a source. */
export type Adding = null | "write" | "install";

/**
 * The skills page: the agent's own and the installed ones listed on the left, with the add form above
 * them; the picked skill's SKILL.md on the right, with refresh and remove. Global skills are not an
 * agent's and live in Settings › skills.
 */
export function SkillsPage({ d, store, viewSkill, onPickSkill, adding, setAdding, reading }: { d: AgentDetails; store: AgentStore; viewSkill: MemorySkillInfo | null; onPickSkill: (name: string) => void; adding: Adding; setAdding: (v: Adding) => void; reading: ReadingState }) {
  return (
    <div style={{ minHeight: 0, display: "grid", gridTemplateColumns: "minmax(260px, 340px) 1fr" }}>
      <ListPane>
        <Head>
          Skills
          <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8 }}>
            <Chip label active={adding === "write"} aria-pressed={adding === "write"} onClick={() => setAdding(adding === "write" ? null : "write")}>write</Chip>
            <Chip label active={adding === "install"} aria-pressed={adding === "install"} onClick={() => setAdding(adding === "install" ? null : "install")}>install</Chip>
          </span>
        </Head>
        {adding && <SkillAdd key={adding} mode={adding} onWrite={store.addSkill} onInstall={store.installSkill} onClose={() => setAdding(null)} agentName={d.agent.name} />}
        {d.skills.length === 0 && !adding && <div className="loki-meta loki-meta--wrap" style={{ padding: "0 8px" }}>none in memory</div>}
        <SkillList skills={d.skills} shown={viewSkill} onPick={onPickSkill} />
        <div className="loki-meta loki-meta--wrap" style={{ padding: "14px 8px 0", lineHeight: 1.5 }}>Skills every agent reads are in Settings › skills.</div>
      </ListPane>
      <Pane>
        <SkillView d={d} store={store} skill={viewSkill} reading={reading} />
      </Pane>
    </div>
  );
}

/** The skills in two groups, the agent's own and the installed ones; installed ones say where they came from. */
function SkillList({ skills, shown, onPick }: { skills: MemorySkillInfo[]; shown: MemorySkillInfo | null; onPick: (name: string) => void }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 10 }}>
      {(["self", "other"] as const).map((origin) => {
        const list = skills.filter((x) => (x.origin ?? "self") === origin);
        if (list.length === 0) return null;
        return (
          <div key={origin} style={{ minWidth: 0 }}>
            <div className="loki-label" style={{ padding: "2px 8px" }}>{sentence(origin)} · {list.length}</div>
            {list.map((x) => {
              const on = shown?.name === x.name;
              return (
                <Row dense key={x.name} selected={on} onClick={() => onPick(x.name)} title={x.description ?? x.name} style={{ justifyContent: "space-between", gap: 8, fontSize: 13.5 }}>
                  <span style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.name}</span>
                  {origin === "other" && (
                    <span style={{ fontSize: 10.5, color: x.source ? "var(--loki-muted)" : "var(--loki-accent)", flex: "0 1 auto", minWidth: 0, maxWidth: "50%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={x.source ? `from ${x.source.label}` : "source unknown"}>
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
  );
}

/** The picked skill, read: its path and actions above, where it came from, its description, then the SKILL.md. */
function SkillView({ d, store, skill, reading }: { d: AgentDetails; store: AgentStore; skill: MemorySkillInfo | null; reading: ReadingState }) {
  const { content, loadingView } = reading;
  if (!skill) return <div className="loki-meta loki-meta--wrap">{d.skills.length ? "pick a skill" : `${d.agent.name} has no skills in memory yet`}</div>;
  return (
    <>
      <SkillActions d={d} store={store} skill={skill} loadingView={loadingView} />
      <div style={{ display: "grid", gap: 4, marginBottom: 14 }}>
        <SkillOrigin skill={skill} agentName={d.agent.name} />
        {skill.description && <div style={{ fontSize: 13.5, color: "var(--loki-muted)", lineHeight: 1.5, maxWidth: 760 }}>{skill.description}</div>}
        {store.needsSource === skill.name && <SourceAsk name={skill.name} onGo={(src) => store.refreshSkill(skill, src)} onCancel={() => store.setNeedsSource(null)} />}
      </div>
      <Prose content={content} loadingView={loadingView} empty="nothing to show here" />
    </>
  );
}

/** The line above a skill: its path, refresh (installed ones) and remove. */
function SkillActions({ d, store, skill, loadingView }: { d: AgentDetails; store: AgentStore; skill: MemorySkillInfo; loadingView: boolean }) {
  const { refreshing, refreshSkill, removeSkill, flash } = store;
  return (
    <div className="loki-label" style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
      <span style={{ color: "var(--loki-fg)", fontFamily: "var(--loki-mono)" }}>{skill.path}</span>
      {loadingView && <span>Loading…</span>}
      <span style={{ flex: 1 }} />
      {skill.origin === "other" && (
        <Button tone="brass" onClick={() => void refreshSkill(skill).then((err) => err && flash(err))} disabled={refreshing === skill.name} title={skill.source ? `pull the latest from ${skill.source.label} and reconcile with ${d.agent.name}'s copy` : "say where this skill came from, then pull the latest"}>
          {refreshing === skill.name ? "refreshing…" : "refresh"}
        </Button>
      )}
      <Button tone="negative" onClick={() => void removeSkill(skill)} title={`remove ${skill.name} from ${d.agent.name}'s memory`}>
        remove
      </Button>
    </div>
  );
}

/** Where the skill came from: written by the agent, from a source, or installed with the source unknown (in the accent, as a nudge). */
function SkillOrigin({ skill, agentName }: { skill: MemorySkillInfo; agentName: string }) {
  return (
    <div style={{ fontSize: 10.5, color: skill.origin === "other" && !skill.source ? "var(--loki-accent)" : "var(--loki-muted)" }}>
      {skill.origin === "self" ? `written by ${agentName}` : skill.source ? `from ${skill.source.label}` : "installed · source unknown"}
      {skill.origin === "other" && skill.edited ? ` · edited by ${agentName} since` : ""}
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
    let err: string | null;
    try {
      err = mode === "write" ? (slug && text.trim() ? await onWrite(slug, `---\nname: ${slug}\ndescription: ${text.trim().split("\n")[0].replace(/^#+\s*/, "").slice(0, 120)}\n---\n\n${text.trim()}\n`) : "a name and some text") : source.trim() ? await onInstall(source) : "a source";
    } finally {
      setBusy(false);
    }
    if (err) return setError(err);
    onClose();
  };
  return (
    <div style={{ display: "grid", gap: 6, margin: "0 0 10px", padding: "8px 10px", border: "1px solid var(--loki-border)", borderRadius: "var(--loki-radius-md)" }}>
      {mode === "write" ? (
        <>
          <Field size="sm" mono autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="skill name (becomes skills/<name>/SKILL.md)" autoComplete="off" data-form-type="other" />
          <TextArea size="sm" value={text} onChange={(e) => setText(e.target.value)} rows={6} placeholder={`# When to use\n\nWhat ${agentName} should do, step by step. The first line becomes the description.`} style={{ lineHeight: 1.5 }} />
        </>
      ) : (
        <>
          <Field size="sm" mono autoFocus value={source} onChange={(e) => setSource(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void go()} placeholder="owner/repo/path · official/finance/stocks · clawhub/<slug> · a GitHub or SKILL.md URL" autoComplete="off" data-form-type="other" />
          <span className="loki-meta loki-meta--wrap">runs <code style={{ fontFamily: "var(--loki-mono)" }}>letta install</code> for {agentName}; can take a minute</span>
        </>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {error && <span className="loki-meta loki-meta--negative loki-meta--wrap">{error}</span>}
        <span style={{ flex: 1 }} />
        <Button onClick={onClose}>cancel</Button>
        <Button tone="positive" onClick={() => void go()} disabled={busy}>{busy ? (mode === "install" ? "installing…" : "writing…") : mode === "install" ? "install" : "add"}</Button>
      </div>
    </div>
  );
}

/** Where an installed skill came from, asked once: a GitHub URL or owner/repo/path, or a folder on this Mac. The mod remembers the answer. */
function SourceAsk({ name, onGo, onCancel }: { name: string; onGo: (source: string) => Promise<string | null>; onCancel: () => void }) {
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    if (busy || !source.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const err = await onGo(source.trim());
      if (err) setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ display: "grid", gap: 6, padding: "8px 10px", border: "1px solid var(--loki-border)", borderRadius: "var(--loki-radius-md)" }}>
      <span className="loki-meta loki-meta--wrap" style={{ lineHeight: 1.4 }}>Nobody wrote down where {name} came from. Say once; it is remembered.</span>
      <Field size="sm" mono autoFocus value={source} onChange={(e) => setSource(e.target.value)} onKeyDown={(e) => (e.key === "Enter" ? void go() : e.key === "Escape" ? onCancel() : undefined)} placeholder="https://github.com/owner/repo/tree/main/skills/name · owner/repo/path · ~/a/folder" autoComplete="off" data-form-type="other" />
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {error && <span className="loki-meta loki-meta--negative loki-meta--wrap">{error}</span>}
        <span style={{ flex: 1 }} />
        <Button onClick={onCancel}>cancel</Button>
        <Button tone="brass" onClick={() => void go()} disabled={busy || !source.trim()}>{busy ? "refreshing…" : "refresh"}</Button>
      </div>
    </div>
  );
}
