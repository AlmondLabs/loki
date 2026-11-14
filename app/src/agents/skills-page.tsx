import { useState } from "react";

import { Button, Chip, Field, TextArea, sentence } from "../components";
import type { ContentRow } from "../shell/content-list";
import { Pane, Prose } from "./bits";
import type { AgentDetails, AgentSkill } from "./types";
import type { AgentStore } from "./use-agent-details";
import type { ReadingState } from "./use-reading";

/** The skills page's add form: write one here, or install from a source. */
export type Adding = null | "write" | "install";

/**
 * The Skills page's items, the list's rows (plan 2026-11-14-1330, KTD9): the agent's own skills, then the installed
 * ones, each group under its heading; a row's line is the skill's description, or for an installed one where it came
 * from ("Source?" in the accent when nobody recorded it).
 */
export function skillRows(skills: readonly AgentSkill[]): ContentRow[] {
  return (["self", "other"] as const).flatMap((origin) =>
    skills
      .filter((x) => (x.origin ?? "self") === origin)
      .map((x): ContentRow => ({
        id: x.name,
        title: x.name,
        preview: origin === "other" ? x.source ? x.source.label : <span style={{ color: "var(--loki-accent)" }}>Source?</span> : (x.description ?? undefined),
        section: sentence(origin),
      })),
  );
}

/**
 * The Skills page's detail: Write and Install, which open the add form, then the skill chosen in the list with refresh
 * and remove. Global skills are not an agent's and live in Preferences › Skills.
 */
export function SkillsPage({
  d,
  store,
  viewSkill,
  adding,
  setAdding,
  reading,
}: {
  d: AgentDetails;
  store: AgentStore;
  viewSkill: AgentSkill | null;
  adding: Adding;
  setAdding: (v: Adding) => void;
  reading: ReadingState;
}) {
  return (
    <Pane>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <Chip label active={adding === "write"} aria-pressed={adding === "write"} onClick={() => setAdding(adding === "write" ? null : "write")}>
          Write
        </Chip>
        <Chip label active={adding === "install"} aria-pressed={adding === "install"} onClick={() => setAdding(adding === "install" ? null : "install")}>
          Install
        </Chip>
        <span className="loki-meta loki-meta--wrap" style={{ marginLeft: "auto" }}>
          Skills every agent reads are in Preferences › Skills.
        </span>
      </div>
      {adding && (
        <SkillAdd key={adding} mode={adding} onWrite={store.addSkill} onInstall={store.installSkill} onClose={() => setAdding(null)} agentName={d.agent.name} />
      )}
      <SkillView d={d} store={store} skill={viewSkill} reading={reading} />
    </Pane>
  );
}

/** The picked skill, read: its path and actions above, where it came from, its description, then the SKILL.md. */
function SkillView({ d, store, skill, reading }: { d: AgentDetails; store: AgentStore; skill: AgentSkill | null; reading: ReadingState }) {
  const { content, loadingView } = reading;
  if (!skill) return <div className="loki-meta loki-meta--wrap">{d.agent.name} has no skills in memory yet.</div>;
  return (
    <>
      <SkillActions d={d} store={store} skill={skill} loadingView={loadingView} />
      <div style={{ display: "grid", gap: 4, marginBottom: 14 }}>
        <SkillOrigin skill={skill} agentName={d.agent.name} />
        {skill.description && (
          <div style={{ fontSize: "var(--loki-text-body)", color: "var(--loki-muted)", lineHeight: 1.5, maxWidth: 760 }}>{skill.description}</div>
        )}
        {store.needsSource === skill.name && (
          <SourceAsk name={skill.name} onGo={(src) => store.refreshSkill(skill, src)} onCancel={() => store.setNeedsSource(null)} />
        )}
      </div>
      <Prose content={content} loadingView={loadingView} empty="Nothing to show here" />
    </>
  );
}

/** The line above a skill: its path, refresh (installed ones) and remove. */
function SkillActions({ d, store, skill, loadingView }: { d: AgentDetails; store: AgentStore; skill: AgentSkill; loadingView: boolean }) {
  const { refreshing, refreshSkill, removeSkill, flash } = store;
  return (
    <div className="loki-label" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
      <span className="loki-mono" style={{ color: "var(--loki-fg)" }}>
        {skill.path}
      </span>
      {loadingView && <span>Loading…</span>}
      <span style={{ flex: 1 }} />
      {skill.origin === "other" && (
        <Button
          tone="brass"
          onClick={() => void refreshSkill(skill).then((err) => err && flash(err))}
          disabled={refreshing === skill.name}
          title={
            skill.source
              ? `Pull the latest from ${skill.source.label} and reconcile with ${d.agent.name}'s copy`
              : "Say where this skill came from, then pull the latest"
          }
        >
          {refreshing === skill.name ? "Refreshing…" : "Refresh"}
        </Button>
      )}
      <Button tone="negative" onClick={() => void removeSkill(skill)} title={`Remove ${skill.name} from ${d.agent.name}'s memory`}>
        Remove
      </Button>
    </div>
  );
}

/** Where the skill came from: written by the agent, from a source, or installed with the source unknown (in the accent, as a nudge). */
function SkillOrigin({ skill, agentName }: { skill: AgentSkill; agentName: string }) {
  return (
    <div style={{ fontSize: "var(--loki-text-fine)", color: skill.origin === "other" && !skill.source ? "var(--loki-accent)" : "var(--loki-muted)" }}>
      {skill.origin === "self" ? `Written by ${agentName}` : skill.source ? `From ${skill.source.label}` : "Installed · source unknown"}
      {skill.origin === "other" && skill.edited ? ` · edited by ${agentName} since` : ""}
    </div>
  );
}

/** Add a skill to this agent: write one here, or install from a source the CLI knows. */
function SkillAdd({
  mode,
  onWrite,
  onInstall,
  onClose,
  agentName,
}: {
  mode: "write" | "install";
  onWrite: (name: string, markdown: string) => Promise<string | null>;
  onInstall: (source: string) => Promise<string | null>;
  onClose: () => void;
  agentName: string;
}) {
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const go = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    let err: string | null;
    try {
      err =
        mode === "write"
          ? slug && text.trim()
            ? await onWrite(
                slug,
                `---\nname: ${slug}\ndescription: ${text
                  .trim()
                  .split("\n")[0]
                  .replace(/^#+\s*/, "")
                  .slice(0, 120)}\n---\n\n${text.trim()}\n`,
              )
            : "A name and some text"
          : source.trim()
            ? await onInstall(source)
            : "A source";
    } finally {
      setBusy(false);
    }
    if (err) return setError(err);
    onClose();
  };
  return (
    <div
      style={{
        display: "grid",
        gap: 6,
        margin: "0 0 10px",
        padding: "8px 10px",
        border: "1px solid var(--loki-border)",
        borderRadius: "var(--loki-radius-md)",
      }}
    >
      {mode === "write" ? (
        <>
          <Field
            size="sm"
            mono
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Skill name (becomes skills/<name>/SKILL.md)"
            autoComplete="off"
            data-form-type="other"
          />
          <TextArea
            size="sm"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            placeholder={`# When to use\n\nWhat ${agentName} should do, step by step. The first line becomes the description.`}
            style={{ lineHeight: 1.5 }}
          />
        </>
      ) : (
        <>
          <Field
            size="sm"
            mono
            autoFocus
            value={source}
            onChange={(e) => setSource(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void go()}
            placeholder="owner/repo/path · a GitHub or git URL · a folder"
            autoComplete="off"
            data-form-type="other"
          />
          <span className="loki-meta loki-meta--wrap">Copies it into {agentName}'s memory; can take a minute</span>
        </>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {error && <span className="loki-meta loki-meta--negative loki-meta--wrap">{error}</span>}
        <span style={{ flex: 1 }} />
        <Button onClick={onClose}>Cancel</Button>
        <Button tone="positive" onClick={() => void go()} disabled={busy}>
          {busy ? (mode === "install" ? "Installing…" : "Writing…") : mode === "install" ? "Install" : "Add"}
        </Button>
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
      <span className="loki-meta loki-meta--wrap" style={{ lineHeight: 1.4 }}>
        Nobody wrote down where {name} came from. Say once; it is remembered.
      </span>
      <Field
        size="sm"
        mono
        autoFocus
        value={source}
        onChange={(e) => setSource(e.target.value)}
        onKeyDown={(e) => (e.key === "Enter" ? void go() : e.key === "Escape" ? onCancel() : undefined)}
        placeholder="https://github.com/owner/repo/tree/main/skills/name · owner/repo/path · ~/a/folder"
        autoComplete="off"
        data-form-type="other"
      />
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {error && <span className="loki-meta loki-meta--negative loki-meta--wrap">{error}</span>}
        <span style={{ flex: 1 }} />
        <Button onClick={onCancel}>Cancel</Button>
        <Button tone="brass" onClick={() => void go()} disabled={busy || !source.trim()}>
          {busy ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
    </div>
  );
}
