import { memoryRoot, memorySection } from "../memory.ts";
import { briefDescription } from "../../mod/skills.ts";
import { skillsOf } from "../skills.ts";

/**
 * What an ACP agent's system prompt gains for one of loki's agents (plan 020, KD5): who it is, its memory (persona
 * included, as loki's own chats have it) and its skills. The ACP agent has none of loki's tools (KD11), so the memory
 * and the skills are named by path for it to read with its own; loki keeps the memory up to date through its passes.
 * Null when the agent has neither.
 */
export function agentPrompt(backendDir: string, agentId: string, name: string | null, globalSkillsDir?: string): string | null {
  const memory = memorySection(memoryRoot(backendDir, agentId), "files");
  const skills = skillsOf(backendDir, agentId, globalSkillsDir);
  if (!memory && !skills.length) return null;
  const who = `You are ${name ?? "one of the person's agents"}, an agent of theirs in loki, working here through this harness. What follows is yours from loki.`;
  const skillText = skills.length
    ? `Skills you have. Before doing the kind of work one describes, read its instructions at its path.\n${skills
        .map((s) => `- ${s.name}${s.description ? `: ${briefDescription(s.description)}` : ""} (${s.file})`)
        .join("\n")}`
    : null;
  return [who, memory ? `<memory>\n${memory}\n</memory>` : null, skillText ? `<skills>\n${skillText}\n</skills>` : null].filter(Boolean).join("\n\n");
}
