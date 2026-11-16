import { useEffect, useEffectEvent, useState } from "react";

import { Button, Field } from "../components";
import { Block, Setting } from "./layout";
import type { GlobalSkill } from "../../../core/frame-types.ts";

export interface GlobalSkillsApi {
  list: () => Promise<GlobalSkill[]>;
  enable: (path: string) => Promise<string | null>;
  disable: (name: string) => Promise<string | null>;
}

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
      <Block help="The folder every agent reads, ~/.agents/skills, while an agent's own skills are on its page in Agents.">
        {skills === null && <Setting label="Skills" help="Reading…" />}
        {skills?.length === 0 && <Setting label="None yet" help="Enable a folder below." />}
        {(skills ?? []).map((g) => (
          <Setting key={g.name} label={g.name} help={g.description ?? g.source ?? (g.is_link ? "A link" : "A copy")}>
            <Button size="sm" onClick={() => void api.disable(g.name).then((err) => (err ? flash(err) : (flash(`${g.name} disabled`), load())))}>
              Disable
            </Button>
          </Setting>
        ))}
        {notice && <div className="loki-meta loki-meta--wrap">{notice}</div>}
      </Block>
      <Block title="Enable a skill" help="A folder holding a SKILL.md, linked into ~/.agents/skills.">
        <PathAdd onAdd={(path) => api.enable(path).then((err) => (err ? err : (flash("Enabled"), load(), null)))} />
      </Block>
    </>
  );
}

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
    <div className="grid gap-1" style={{ padding: "12px 0" }}>
      <div className="flex gap-2">
        <Field
          size="sm"
          mono
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void go()}
          placeholder="/path/to/skill"
          aria-label="Skill folder"
          autoComplete="off"
          data-form-type="other"
          className="flex-1"
        />
        <Button size="sm" onClick={() => void go()} disabled={busy || !path.trim()}>
          {busy ? "Enabling…" : "Enable"}
        </Button>
      </div>
      {error && (
        <span role="alert" className="loki-meta loki-meta--negative loki-meta--wrap">
          {error}
        </span>
      )}
    </div>
  );
}
