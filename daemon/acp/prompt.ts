import { memoryRoot, memorySection } from "../memory.ts";
import { briefDescription } from "../../mod/skills.ts";
import { skillsOf } from "../skills.ts";
import { LOKI_TOOLS_SERVER } from "./loki-tools.ts";

/**
 * What an ACP agent's system prompt gains for one of loki's agents (plan 020, KD5): who it is, its memory (persona
 * included, as loki's own chats have it) and its skills. With loki's tools (plan 044) it changes its memory with them,
 * as in loki's own chats; without them, the memory is named by path for it to read and loki keeps it up to date through
 * its passes. The skills are named by path either way. Null when the agent has neither and no tools reach it: with
 * tools, the prompt still names suggestion_create, since a tool description alone may never be read.
 */
export function agentPrompt(backendDir: string, agentId: string, name: string | null, withTools: boolean, globalSkillsDir?: string): string | null {
  const memory = memorySection(memoryRoot(backendDir, agentId), withTools ? "tools" : "files");
  const skills = skillsOf(backendDir, agentId, globalSkillsDir);
  if (!memory && !skills.length && !withTools) return null;
  const who = `You are ${name ?? "one of the person's agents"}, an agent of theirs in loki, working here through this harness. What follows is yours from loki.`;
  const skillText = skills.length
    ? `Skills you have. Before doing the kind of work one describes, read its instructions at its path.\n${skills
        .map((s) => `- ${s.name}${s.description ? `: ${briefDescription(s.description)}` : ""} (${s.file})`)
        .join("\n")}`
    : null;
  const tools = withTools
    ? `loki's tools reach you as the "${LOKI_TOOLS_SERVER}" MCP server (mcp__${LOKI_TOOLS_SERVER}__memory_read and the rest). Change your memory only with its memory tools, never by editing the files, so each change is committed as yours. When a piece of work would be done better in another chat, suggest it there with mcp__${LOKI_TOOLS_SERVER}__suggestion_create; its description says when.`
    : null;
  return [who, tools, memory ? `<memory>\n${memory}\n</memory>` : null, skillText ? `<skills>\n${skillText}\n</skills>` : null].filter(Boolean).join("\n\n");
}
