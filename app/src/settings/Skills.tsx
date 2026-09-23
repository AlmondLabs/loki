import { useEffect, useState } from "react";
import type { GlobalSkill } from "../../../mod/skills.ts";
import { Button, Field } from "../components";

/** Settings › skills: the folder every agent reads, and the two things you do to it. */
export interface GlobalSkillsApi {
  list: () => Promise<GlobalSkill[]>;
  /** Link a folder holding a SKILL.md into ~/.letta/skills (Letta's skill_enable); an error message or null. */
  enable: (path: string) => Promise<string | null>;
  disable: (name: string) => Promise<string | null>;
}

/**
 * The global skills, one line each: the name, where it came from when known (the checkout a link points
 * into, or the repo the `skills` CLI recorded), and disable. Below, a field to enable a folder. These are
 * every agent's, not one agent's, which is why they live here and not on the Agents page.
 */
export function Skills({ api }: { api: GlobalSkillsApi }) {
  const [skills, setSkills] = useState<GlobalSkill[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = () => void api.list().then(setSkills);
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
  const flash = (m: string) => {
    setNotice(m);
    setTimeout(() => setNotice(null), 2500);
  };
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {skills === null && <div className="loki-meta loki-meta--wrap">reading…</div>}
      {skills?.length === 0 && <div className="loki-meta loki-meta--wrap">none</div>}
      <div style={{ display: "grid", gap: 2 }}>
        {(skills ?? []).map((g) => (
          <div key={g.name} style={{ display: "flex", alignItems: "center", gap: 10, padding: "3px 0 3px 8px", borderRadius: "var(--loki-radius-sm)" }} title={g.description ?? g.path}>
            <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.name}</span>
            <span className="loki-meta" style={{ maxWidth: "45%" }}>{g.source ?? (g.isLink ? "link" : "copy")}</span>
            <Button size="sm" onClick={() => void api.disable(g.name).then((err) => (err ? flash(err) : (flash(`${g.name} disabled`), load())))}>disable</Button>
          </div>
        ))}
      </div>
      <PathAdd onAdd={(path) => api.enable(path).then((err) => (err ? err : (flash("enabled"), load(), null)))} />
      {notice && <div className="loki-meta loki-meta--wrap">{notice}</div>}
    </div>
  );
}

/** Enable a folder as a global skill: a path field, one line. */
function PathAdd({ onAdd }: { onAdd: (path: string) => Promise<string | null> }) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    if (busy || !path.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const err = await onAdd(path.trim().replace(/^~(?=\/|$)/, "$HOME"));
      if (err) return setError(err);
      setPath("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <div style={{ display: "flex", gap: 6 }}>
        <Field size="sm" mono value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void go()} placeholder="enable a folder: /path/to/skill (holding a SKILL.md)" autoComplete="off" data-form-type="other" style={{ flex: 1 }} />
        <Button size="sm" onClick={() => void go()} disabled={busy || !path.trim()}>{busy ? "enabling…" : "enable"}</Button>
      </div>
      {error && <span className="loki-meta loki-meta--negative loki-meta--wrap">{error}</span>}
    </div>
  );
}
