import { useEffect, useState } from "react";
import type { MemoryCommit, MemorySkill } from "../../../mod/agents.ts";
import type { MemorySkillInfo } from "../../../mod/skill-sources.ts";
import type { AgentDetails, AgentEdit, AgentsApi, AgentsWrite } from "./types";

/**
 * The selected agent's record and memory log, loaded once per agent and kept by id, and the writes
 * against it: save the identity, delete the agent, add, install, refresh or remove a skill. Each write
 * reports through `notice` (a line that clears itself after three seconds) and reloads the agent.
 * `confirmDelete`, `refreshing` and `needsSource` are the writes' confirm and in-flight state.
 */
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
  /** The agent is gone: the caller drops its pick. */
  onDeleted: () => void;
  /** A skill was written: the caller shows it. */
  onSkillAdded: (name: string) => void;
}) {
  const [details, setDetails] = useState<Record<string, AgentDetails | null | undefined>>({});
  const [commits, setCommits] = useState<Record<string, MemoryCommit[]>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const load = async (id: string) => {
    const d = await api.get(id);
    setDetails((x) => ({ ...x, [id]: d }));
    const log = await api.log(id, undefined, 40);
    setCommits((x) => ({ ...x, [id]: log }));
  };
  useEffect(() => {
    if (selected && details[selected] === undefined) void load(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const d = selected ? details[selected] : undefined;
  const log = selected ? commits[selected] ?? [] : [];
  const flash = (m: string) => {
    setNotice(m);
    setTimeout(() => setNotice((c) => (c === m ? null : c)), 3000);
  };
  const save = async (body: AgentEdit) => {
    if (!selected) return;
    const err = await onUpdateAgent(selected, body);
    if (err) return flash(err);
    flash("saved");
    void load(selected);
  };
  const [confirmDelete, setConfirmDelete] = useState(false);
  const remove = async () => {
    if (!selected || !d) return;
    const name = d.agent.name;
    const err = await write.deleteAgent(selected);
    setConfirmDelete(false);
    if (err) return flash(err);
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
    if (!selected) return "no agent selected";
    const path = `skills/${name}/SKILL.md`;
    const err = await write.writeMemory(selected, path, markdown, `feat: add skill ${name}`);
    if (err) return err;
    flash(`${name} added`);
    void load(selected);
    onSkillAdded(name);
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

  return { d, log, notice, flash, save, confirmDelete, setConfirmDelete, remove, removeSkill, addSkill, installSkill, refreshing, needsSource, setNeedsSource, refreshSkill };
}

export type AgentStore = ReturnType<typeof useAgentDetails>;
