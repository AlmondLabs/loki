import { useEffect, useState } from "react";
import type { GlobalSkill } from "../../../mod/skills.ts";
import { btn } from "../chat/ui";

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
      {skills === null && <div style={{ fontSize: 12, color: "var(--loki-muted)" }}>reading…</div>}
      {skills?.length === 0 && <div style={{ fontSize: 12, color: "var(--loki-muted)" }}>none</div>}
      <div style={{ display: "grid", gap: 2 }}>
        {(skills ?? []).map((g) => (
          <div key={g.name} className="loki-tree-row" style={{ display: "flex", alignItems: "center", gap: 10, padding: "3px 0 3px 8px", borderRadius: 6 }} title={g.description ?? g.path}>
            <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontFamily: "var(--loki-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.name}</span>
            <span style={{ fontSize: 10.5, color: "var(--loki-muted)", fontFamily: "var(--loki-mono)", letterSpacing: "0.06em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "45%" }}>{g.source ?? (g.isLink ? "link" : "copy")}</span>
            <button onClick={() => void api.disable(g.name).then((err) => (err ? flash(err) : (flash(`${g.name} disabled`), load())))} style={{ ...btn(), padding: "2px 7px", fontSize: 10.5 }}>disable</button>
          </div>
        ))}
      </div>
      <PathAdd onAdd={(path) => api.enable(path).then((err) => (err ? err : (flash("enabled"), load(), null)))} />
      {notice && <div style={{ fontSize: 12, color: "var(--loki-accent)" }}>{notice}</div>}
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
    const err = await onAdd(path.trim().replace(/^~(?=\/|$)/, "$HOME"));
    setBusy(false);
    if (err) return setError(err);
    setPath("");
  };
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <div style={{ display: "flex", gap: 6 }}>
        <input value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void go()} placeholder="enable a folder: /path/to/skill (holding a SKILL.md)" autoComplete="off" data-form-type="other" style={{ flex: 1, padding: "5px 10px", fontSize: 12, background: "var(--loki-well)", border: "1px solid var(--loki-border)", borderRadius: 6, color: "var(--loki-fg)", outline: "none", fontFamily: "var(--loki-mono)" }} />
        <button onClick={() => void go()} disabled={busy || !path.trim()} style={{ ...btn(), opacity: busy || !path.trim() ? 0.5 : 1 }}>{busy ? "enabling…" : "enable"}</button>
      </div>
      {error && <span style={{ fontSize: 12, color: "var(--loki-negative)", fontFamily: "var(--loki-mono)" }}>{error}</span>}
    </div>
  );
}
