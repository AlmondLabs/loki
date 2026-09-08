/**
 * The pages down the left of an agent (app/src/agents/Agents.tsx), in the order they are listed.
 * profile: who it is and where it works. memory: the files, read. changes: what it learned, as a
 * timeline of commits. skills: its own and the installed ones, with refresh. Global skills are not
 * an agent's and live in Settings › skills. The phone's Agent screen uses the same four words as
 * headings in one scroll.
 */
export type AgentPage = "profile" | "memory" | "changes" | "skills";
export const AGENT_PAGES: readonly AgentPage[] = ["profile", "memory", "changes", "skills"];
/** The page is remembered for the window, like Settings' (sessionStorage). */
export const AGENT_PAGE_KEY = "loki.agentsPage";
/** Where a first visit lands: the reading room. */
export const DEFAULT_AGENT_PAGE: AgentPage = "memory";

export function isAgentPage(v: unknown): v is AgentPage {
  return typeof v === "string" && (AGENT_PAGES as readonly string[]).includes(v);
}

/** One-line hints under each page title. */
export const AGENT_PAGE_HINT: Record<AgentPage, string> = {
  profile: "who it is, and where it is working",
  memory: "what it knows, file by file",
  changes: "what it learned, newest first",
  skills: "its own, and the ones installed from elsewhere",
};
