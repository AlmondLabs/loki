import { memoryRoot, memorySection } from "../memory.ts";
import { briefDescription } from "../../mod/skills.ts";
import { skillsOf } from "../skills.ts";
import { REPLIES_PROMPT } from "../replies.ts";
import { LOKI_TOOLS_SERVER } from "./loki-tools.ts";

/**
 * What an ACP agent's system prompt gains for one of loki's agents (plan 020, KD5): who it is, its memory (persona
 * included, as loki's own chats have it) and its skills. With loki's tools (plan 044) it changes its memory with them,
 * as in loki's own chats; without them, the memory is named by path for it to read and loki keeps it up to date through
 * its passes. The skills are named by path either way. Every agent is told about quick replies (plan 066), which need
 * no tool; with tools, the prompt also names suggestion_create and the script tool, through which the history tools
 * (plan 063), the canvas, schedules and the chat list are reached (plan 099), since a tool description alone may never
 * be read.
 */
export function agentPrompt(backendDir: string, agentId: string, name: string | null, withTools: boolean, globalSkillsDir?: string): string {
  const memory = memorySection(memoryRoot(backendDir, agentId), withTools ? "tools" : "files");
  const skills = skillsOf(backendDir, agentId, globalSkillsDir);
  const who = `You are ${name ?? "one of the person's agents"}, an agent of theirs in loki, working here through this harness. What follows is yours from loki.`;
  const skillText = skills.length
    ? `Skills you have. Before doing the kind of work one describes, read its instructions at its path.\n${skills
        .map((s) => `- ${s.name}${s.description ? `: ${briefDescription(s.description)}` : ""} (${s.file})`)
        .join("\n")}`
    : null;
  const tools = withTools
    ? `loki's tools reach you as the "${LOKI_TOOLS_SERVER}" MCP server (mcp__${LOKI_TOOLS_SERVER}__memory_read and the rest). Change your memory only with its memory tools, never by editing the files, so each change is committed as yours. When a piece of work would be done better in another chat, suggest it there with mcp__${LOKI_TOOLS_SERVER}__suggestion_create; its description says when. Every turn of this chat is kept, including what your own compaction or a lost session dropped: find earlier turns with a script (mcp__${LOKI_TOOLS_SERVER}__script calling history_search, then history_read) before you guess. Scripts also read the canvas, list and change your schedules, and list the person's chats.`
    : null;
  return [who, tools, REPLIES_PROMPT, memory ? `<memory>\n${memory}\n</memory>` : null, skillText ? `<skills>\n${skillText}\n</skills>` : null]
    .filter(Boolean)
    .join("\n\n");
}
