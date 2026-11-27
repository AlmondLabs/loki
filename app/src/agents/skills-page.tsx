import { useState } from "react";

import { Button, Field, Meta, Sheet, TextArea } from "../components";
import type { ContentRow } from "../shell/content-list";
import { Pane, Prose } from "./bits";
import type { AgentDetails, AgentSkill } from "./types";
import type { AgentStore } from "./use-agent-details";
import type { ReadingState } from "./use-reading";

export type Adding = null | "write" | "install";

export function skillRows(skills: readonly AgentSkill[], query = ""): ContentRow[] {
  const q = query.trim().toLowerCase();
  return (["self", "other"] as const).flatMap((origin) =>
    skills
      .filter((x) => (x.origin ?? "self") === origin)
      .filter((x) => !q || [x.name, x.description ?? "", x.source?.label ?? ""].some((s) => s.toLowerCase().includes(q)))
      .map((x): ContentRow => ({
        id: x.name,
        title: x.name,
        preview: origin === "other" ? x.source ? x.source.label : <span style={{ color: "var(--loki-accent)" }}>Source?</span> : (x.description ?? undefined),
        section: origin === "self" ? "Self" : "Installed",
      })),
  );
}

export function SkillsPage({
  d,
  store,
  viewSkill,
  adding,
  setAdding,
  confirmRemove,
  setConfirmRemove,
  reading,
  onOpenGlobalSkills,
}: {
  d: AgentDetails;
  store: AgentStore;
  viewSkill: AgentSkill | null;
  adding: Adding;
  setAdding: (v: Adding) => void;
  confirmRemove: AgentSkill | null;
  setConfirmRemove: (skill: AgentSkill | null) => void;
  reading: ReadingState;
  onOpenGlobalSkills?: () => void;
}) {
  return (
    <Pane>
      <SkillView d={d} viewSkill={viewSkill} reading={reading} onOpenGlobalSkills={onOpenGlobalSkills} />
      {adding && (
        <Sheet label={adding === "write" ? "Write skill" : "Install skill"} onClose={() => setAdding(null)} width={520} top="12vh" scroll>
          <SkillAdd
            key={adding}
            mode={adding}
            onWrite={store.addSkill}
            onInstall={store.installSkill}
            onClose={() => setAdding(null)}
            agentName={d.agent.name}
          />
        </Sheet>
      )}
      {viewSkill && store.needsSource === viewSkill.name && (
        <Sheet label={`Source for ${viewSkill.name}`} onClose={() => store.setNeedsSource(null)} width={520} top="14vh">
          <SourceAsk name={viewSkill.name} onGo={(src) => store.refreshSkill(viewSkill, src)} onCancel={() => store.setNeedsSource(null)} />
        </Sheet>
      )}
      {confirmRemove && (
        <ConfirmRemoveSkill
          skill={confirmRemove}
          agentName={d.agent.name}
          onConfirm={async () => {
            await store.removeSkill(confirmRemove);
            setConfirmRemove(null);
          }}
          onCancel={() => setConfirmRemove(null)}
        />
      )}
    </Pane>
  );
}

function SkillView({
  d,
  viewSkill,
  reading,
  onOpenGlobalSkills,
}: {
  d: AgentDetails;
  viewSkill: AgentSkill | null;
  reading: ReadingState;
  onOpenGlobalSkills?: () => void;
}) {
  const { content, loadingView } = reading;
  return (
    <div className="grid gap-4" style={{ maxWidth: 760 }}>
      {!viewSkill ? (
        <Meta wrap>{d.agent.name} has no skills in memory yet.</Meta>
      ) : (
        <>
          <div className="grid gap-1">
            <div style={{ fontSize: "var(--text-base)", fontWeight: 600, color: "var(--loki-fg)" }}>{viewSkill.name}</div>
            <div className="loki-meta loki-meta--wrap flex flex-wrap items-center gap-2">
              <SkillOrigin skill={viewSkill} agentName={d.agent.name} />
              <span className="loki-mono">· {viewSkill.path}</span>
              {loadingView && <span>· Loading…</span>}
            </div>
            {viewSkill.description && (
              <div style={{ fontSize: "var(--text-sm)", color: "var(--loki-muted)", lineHeight: 1.5, marginTop: 4 }}>{viewSkill.description}</div>
            )}
          </div>
          <Prose content={content} loadingView={loadingView} empty="Nothing to show here" />
        </>
      )}
      <div className="loki-meta loki-meta--wrap flex items-center gap-1" style={{ paddingTop: 12, borderTop: "1px solid var(--loki-border)" }}>
        <span>Skills every agent reads are in</span>
        {onOpenGlobalSkills ? (
          <Button bare size="sm" tone="brass" onClick={onOpenGlobalSkills} style={{ minHeight: 0, padding: "0 4px", fontSize: "var(--text-xs)" }}>
            Preferences › Skills
          </Button>
        ) : (
          <span>Preferences › Skills.</span>
        )}
      </div>
    </div>
  );
}

function SkillOrigin({ skill, agentName }: { skill: AgentSkill; agentName: string }) {
  const unattributed = skill.origin === "other" && !skill.source;
  return (
    <span style={unattributed ? { color: "var(--loki-accent)" } : undefined}>
      {skill.origin === "self" ? `Written by ${agentName}` : skill.source ? `From ${skill.source.label}` : "Installed · source unknown"}
      {skill.origin === "other" && skill.edited ? ` · edited by ${agentName} since` : ""}
    </span>
  );
}

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
    if (mode === "write" && (!slug || !text.trim())) return setError("A name and some text");
    if (mode !== "write" && !source.trim()) return setError("A source");
    setBusy(true);
    setError(null);
    const markdown =
      mode === "write"
        ? `---\nname: ${slug}\ndescription: ${text
            .trim()
            .split("\n")[0]
            .replace(/^#+\s*/, "")
            .slice(0, 120)}\n---\n\n${text.trim()}\n`
        : "";
    const run = mode === "write" ? () => onWrite(slug, markdown) : () => onInstall(source);
    let err: string | null;
    try {
      err = await run();
    } catch (e) {
      setBusy(false);
      throw e;
    }
    setBusy(false);
    if (err) return setError(err);
    onClose();
  };
  return (
    <div className="grid gap-4" style={{ padding: 20 }}>
      <div style={{ fontSize: "var(--text-base)", fontWeight: 700, color: "var(--loki-fg)" }}>{mode === "write" ? "Write skill" : "Install skill"}</div>
      {mode === "write" ? (
        <div className="grid gap-3">
          <label className="grid gap-1">
            <span className="loki-label">Name</span>
            <Field
              size="sm"
              mono
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="skills/<name>/SKILL.md"
              aria-label="Skill name"
              autoComplete="off"
              data-form-type="other"
            />
          </label>
          <label className="grid gap-1">
            <span className="loki-label">Instructions</span>
            <TextArea
              size="sm"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={7}
              aria-label="What the skill says"
              placeholder={`# When to use\n\nWhat ${agentName} should do, step by step. The first line becomes the description.`}
              style={{ lineHeight: 1.5 }}
            />
          </label>
        </div>
      ) : (
        <div className="grid gap-2">
          <label className="grid gap-1">
            <span className="loki-label">Source</span>
            <Field
              size="sm"
              mono
              autoFocus
              value={source}
              onChange={(e) => setSource(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void go()}
              placeholder="owner/repo/path · a GitHub or git URL · a folder"
              aria-label="Where the skill comes from"
              autoComplete="off"
              data-form-type="other"
            />
          </label>
          <Meta wrap>Copies it into {agentName}'s memory; can take a minute.</Meta>
        </div>
      )}
      <div className="flex items-center gap-2">
        {error && (
          <Meta role="alert" negative wrap>
            {error}
          </Meta>
        )}
        <span className="flex-1" />
        <Button size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" tone="positive" onClick={() => void go()} disabled={busy}>
          {busy ? (mode === "install" ? "Installing…" : "Writing…") : mode === "install" ? "Install Skill" : "Add Skill"}
        </Button>
      </div>
    </div>
  );
}

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
    } catch (e) {
      setBusy(false);
      throw e;
    }
    setBusy(false);
  };
  return (
    <div className="grid gap-4" style={{ padding: 20 }}>
      <div className="grid gap-1">
        <div style={{ fontSize: "var(--text-base)", fontWeight: 700, color: "var(--loki-fg)" }}>{`Source for ${name}`}</div>
        <Meta wrap>Nobody wrote down where {name} came from. Say once; it is remembered.</Meta>
      </div>
      <Field
        size="sm"
        mono
        autoFocus
        value={source}
        onChange={(e) => setSource(e.target.value)}
        onKeyDown={(e) => (e.key === "Enter" ? void go() : e.key === "Escape" ? onCancel() : undefined)}
        placeholder="https://github.com/owner/repo/tree/main/skills/name · owner/repo/path · ~/a/folder"
        aria-label={`Where ${name} came from`}
        autoComplete="off"
        data-form-type="other"
      />
      <div className="flex items-center gap-2">
        {error && (
          <Meta role="alert" negative wrap>
            {error}
          </Meta>
        )}
        <span className="flex-1" />
        <Button size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" tone="positive" onClick={() => void go()} disabled={busy || !source.trim()}>
          {busy ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
    </div>
  );
}

function ConfirmRemoveSkill({
  skill,
  agentName,
  onConfirm,
  onCancel,
}: {
  skill: AgentSkill;
  agentName: string;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-4" style={{ padding: 20 }}>
      <div className="grid gap-2">
        <div style={{ fontSize: "var(--text-base)", fontWeight: 700, color: "var(--loki-fg)" }}>{`Remove ${skill.name}?`}</div>
        <div style={{ fontSize: "var(--text-sm)", color: "var(--loki-muted)", lineHeight: 1.5 }}>
          Removes <span className="loki-mono">{skill.path}</span> from {agentName}'s memory with a git commit.
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" tone="negative" disabled={busy} onClick={() => void run()}>
          {busy ? "Removing…" : "Remove Skill"}
        </Button>
      </div>
    </div>
  );
}
