import { useEffect, useEffectEvent, useState } from "react";

import type { AgentDetails, AgentEdit, AgentSkill, AgentsApi, AgentsWrite } from "./types";
import type { MemoryCommit, MemorySkill } from "../../../core/frame-types.ts";

export function useAgentDetails({
  selected,
  api,
  write,
  onUpdateAgent,
  onAskToUpdate,
  onDeleted,
  onSkillAdded,
}: {
  selected: string | null;
  api: AgentsApi;
  write: AgentsWrite;
  onUpdateAgent: (agentId: string, body: AgentEdit) => Promise<string | null>;
  onAskToUpdate: (agentId: string, text: string) => void;
  onDeleted: () => void;
  onSkillAdded: (name: string) => void;
}) {
  const [details, setDetails] = useState<Record<string, AgentDetails | null | undefined>>({});
  const [commits, setCommits] = useState<Record<string, MemoryCommit[]>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const load = (id: string) =>
    api
      .get(id)
      .then((d) => {
        setDetails((x) => ({ ...x, [id]: d }));
        return api.log(id, undefined, 40);
      })
      .then((log) => setCommits((x) => ({ ...x, [id]: log })));
  const loadIfUnseen = useEffectEvent((id: string) => {
    if (!details[id]) void load(id);
  });
  useEffect(() => {
    if (selected) loadIfUnseen(selected);
  }, [selected]);

  const d = selected ? details[selected] : undefined;
  const log = selected ? (commits[selected] ?? []) : [];
  const flash = (m: string) => {
    setNotice(m);
    setTimeout(() => setNotice((c) => (c === m ? null : c)), 3000);
  };
  const save = async (body: AgentEdit) => {
    if (!selected) return;
    const err = await onUpdateAgent(selected, body);
    if (err) return flash(err);
    flash("Saved");
    void load(selected);
  };
  const [confirmDelete, setConfirmDelete] = useState(false);
  const remove = async () => {
    if (!selected || !d) return;
    const name = d.agent.name;
    const err = await write.deleteAgent(selected);
    if (err) return flash(err);
    setConfirmDelete(false);
    setDetails((x) => ({ ...x, [selected]: undefined }));
    onDeleted();
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
    if (!selected) return "No agent selected";
    const path = `skills/${name}/SKILL.md`;
    const err = await write.writeMemory(selected, path, markdown, `feat: add skill ${name}`);
    if (err) return err;
    flash(`${name} added`);
    void load(selected);
    onSkillAdded(name);
    return null;
  };
  const installSkill = async (source: string) => {
    if (!selected) return "No agent selected";
    const err = await api.installSkill(selected, source, true);
    if (err) return err;
    flash("Installed");
    void load(selected);
    return null;
  };
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [needsSource, setNeedsSource] = useState<string | null>(null);
  const refreshSkill = async (skill: AgentSkill, source?: string): Promise<string | null> => {
    if (!selected || !d) return "No agent selected";
    if (!source && !skill.source) {
      setNeedsSource(skill.name);
      return null;
    }
    setRefreshing(skill.name);
    let r: Awaited<ReturnType<AgentsApi["refreshSkill"]>>;
    try {
      r = await api.refreshSkill(selected, skill.name, source);
    } finally {
      setRefreshing(null);
    }
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

  const revertCommit = async (sha: string) => {
    if (!selected) return;
    const err = await write.revertMemory(selected, sha);
    if (err) return flash(err);
    flash(`Reverted ${sha.slice(0, 8)}: the undo is the newest commit`);
    void load(selected);
  };
  return {
    d,
    log,
    notice,
    flash,
    save,
    confirmDelete,
    setConfirmDelete,
    remove,
    removeSkill,
    addSkill,
    installSkill,
    refreshing,
    needsSource,
    setNeedsSource,
    refreshSkill,
    revertCommit,
  };
}

export type AgentStore = ReturnType<typeof useAgentDetails>;
