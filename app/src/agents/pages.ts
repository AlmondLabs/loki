export type AgentPage = "profile" | "memory" | "changes" | "reflection" | "skills";
export const AGENT_PAGES: readonly AgentPage[] = ["profile", "memory", "changes", "reflection", "skills"];
export const AGENT_PAGE_KEY = "loki.agentsPage";
export const DEFAULT_AGENT_PAGE: AgentPage = "memory";

export function isAgentPage(v: unknown): v is AgentPage {
  return typeof v === "string" && (AGENT_PAGES as readonly string[]).includes(v);
}

export const AGENT_PAGE_HINT: Record<AgentPage, string> = {
  profile: "Who it is, and where it is working",
  memory: "What it knows, file by file",
  changes: "What it learned, newest first",
  reflection: "When it sleeps on what happened, and what came of it",
  skills: "Its own, and the ones installed from elsewhere",
};

export const AGENT_PAGE_LABEL: Record<AgentPage, string> = {
  profile: "Profile",
  memory: "Memory",
  changes: "Changes",
  reflection: "Reflection",
  skills: "Skills",
};
