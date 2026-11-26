import { agent, compiledCheck, isAgentId, NonEmptyStr, nothing, str, strOr, type Raw } from "./primitives.ts";
import { PHONE, push, request } from "./types.ts";

const checkNonEmpty = compiledCheck(NonEmptyStr);

export const agentsFrames = {
  agent_get: request("agent", "an agent's local record, memory tree, skills, face and last memory commit", agent, PHONE),
  memory_read: request(
    "memory_file",
    "one memory file (content null when missing)",
    (m: Raw) => (isAgentId(m.agent_id) ? (checkNonEmpty(m.path) ? { agent_id: m.agent_id, path: m.path } : "path required") : "agent_id required"),
    PHONE,
  ),
  memory_log: request(
    "memory_commits",
    "memory's git log, for a path or all of it",
    (m: Raw) =>
      isAgentId(m.agent_id)
        ? { agent_id: m.agent_id, path: strOr(m.path, undefined), limit: typeof m.limit === "number" ? m.limit : undefined }
        : "agent_id required",
    PHONE,
  ),
  memory_diff: request(
    "memory_diff",
    "one memory commit's diff",
    (m: Raw) => (isAgentId(m.agent_id) ? (checkNonEmpty(m.sha) ? { agent_id: m.agent_id, sha: m.sha } : "sha required") : "agent_id required"),
    PHONE,
  ),
  reflection_state: request("reflection_state", "the last reflection pass that changed an agent's memory", agent),
  skills_global: request("skills_global", "skills outside memory (~/.agents/skills)", nothing),
  skill_install: request("skill_installed", "install a skill into an agent's memory", (m: Raw) =>
    isAgentId(m.agent_id) && str(m.source) && m.source ? { agent_id: m.agent_id, source: m.source, force: m.force === true } : "agent_id and source required",
  ),
  skill_refresh: request("skill_refreshed", "refresh an other skill from its upstream: current, replaced, or staged for the agent to reconcile", (m: Raw) =>
    isAgentId(m.agent_id) && str(m.name) && m.name ? { agent_id: m.agent_id, name: m.name, source: strOr(m.source, undefined) } : "agent_id and name required",
  ),

  agents_changed: push("an agent was created, renamed or deleted, or agents were imported; clients ask for the agents, chats and desks again", { lists: true }),
  memory_changed: push("an agent's memory has new commits on this Mac"),
} as const;
