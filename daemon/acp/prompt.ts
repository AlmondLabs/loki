import { memoryRoot, memorySection, sharedMemoryRoot } from "../memory.ts";
import { briefDescription } from "../../mod/skills.ts";
import { sections } from "../section-cache.ts";
import { skillsOf } from "../skills.ts";
import { REPLIES_PROMPT } from "../replies.ts";
import { LOKI_TOOLS_SERVER } from "./loki-tools.ts";

export function agentPrompt(backendDir: string, agentId: string, name: string | null, withTools: boolean, globalSkillsDir?: string): string {
  const root = memoryRoot(backendDir, agentId);
  const sharedRoot = sharedMemoryRoot(backendDir);
  const how = withTools ? "tools" : "files";
  const memory = sections.get(`memory\u0000${root}\u0000${sharedRoot}\u0000${how}`, () => memorySection(root, how, sharedRoot));
  const skills = skillsOf(backendDir, agentId, globalSkillsDir);
  const who = `You are ${name ?? "one of the person's agents"}, an agent of theirs in loki, working here through this harness. What follows is yours from loki.`;
  const skillText = skills.length
    ? sections.get(
        `acp-skills\u0000${root}\u0000${backendDir}\u0000${globalSkillsDir ?? ""}`,
        () =>
          `Skills you have. Before doing the kind of work one describes, read its instructions at its path.\n${skills
            .map((s) => `- ${s.name}${s.description ? `: ${briefDescription(s.description)}` : ""} (${s.file})`)
            .join("\n")}`,
      )
    : null;
  const tools = withTools
    ? `loki's tools reach you as the "${LOKI_TOOLS_SERVER}" MCP server (mcp__${LOKI_TOOLS_SERVER}__memory_read and the rest). Change your memory only with its memory tools, never by editing the files, so each change is committed as yours. When a piece of work would be done better in another chat, suggest it there with mcp__${LOKI_TOOLS_SERVER}__suggestion_create; its description says when. Every turn of this chat is kept, including what your own compaction or a lost session dropped: find earlier turns with a script (mcp__${LOKI_TOOLS_SERVER}__script calling history_search, then history_read) before you guess. Scripts also read the canvas, list and change your schedules, and list the person's chats.`
    : null;
  return [who, tools, REPLIES_PROMPT, memory ? `<memory>\n${memory}\n</memory>` : null, skillText ? `<skills>\n${skillText}\n</skills>` : null]
    .filter(Boolean)
    .join("\n\n");
}
