import { useEffect, useEffectEvent, useState } from "react";

import { Button, Field } from "../components";
import { Block, Setting } from "./layout";
import type { GlobalSkill } from "../../../core/frame-types.ts";

/** Settings › skills: the folder every agent reads, and the two things you do to it. */
export interface GlobalSkillsApi {
  list: () => Promise<GlobalSkill[]>;
  /** Link a folder holding a SKILL.md into ~/.agents/skills (chat_skill_enable); an error message or null. */
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
  const loadOnOpen = useEffectEvent(load);
  useEffect(() => loadOnOpen(), []);
  const flash = (m: string) => {
    setNotice(m);
    setTimeout(() => setNotice(null), 2500);
  };
  return (
    <>
      <Block help="the folder every agent reads, ~/.agents/skills. An agent's own skills are on its page in Agents.">
        {skills === null && <Setting label="Skills" help="reading…" />}
        {skills?.length === 0 && <Setting label="None yet" help="Enable a folder below." />}
        {(skills ?? []).map((g) => (
          <Setting key={g.name} label={g.name} help={g.description ?? g.source ?? (g.is_link ? "a link" : "a copy")}>
            <Button size="sm" onClick={() => void api.disable(g.name).then((err) => (err ? flash(err) : (flash(`${g.name} disabled`), load())))}>
              disable
            </Button>
          </Setting>
        ))}
        {notice && <div className="loki-meta loki-meta--wrap">{notice}</div>}
      </Block>
      <Block title="Enable a skill" help="a folder holding a SKILL.md, linked into ~/.agents/skills.">
        <PathAdd onAdd={(path) => api.enable(path).then((err) => (err ? err : (flash("enabled"), load(), null)))} />
      </Block>
    </>
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
    <div style={{ display: "grid", gap: 4, padding: "12px 0" }}>
      <div style={{ display: "flex", gap: 6 }}>
        <Field
          size="sm"
          mono
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void go()}
          placeholder="/path/to/skill"
          autoComplete="off"
          data-form-type="other"
          style={{ flex: 1 }}
        />
        <Button size="sm" onClick={() => void go()} disabled={busy || !path.trim()}>
          {busy ? "enabling…" : "enable"}
        </Button>
      </div>
      {error && <span className="loki-meta loki-meta--negative loki-meta--wrap">{error}</span>}
    </div>
  );
}
