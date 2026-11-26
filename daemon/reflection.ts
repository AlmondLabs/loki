import { CONFLICTS_PATH, pendingConflicts } from "./memory-sync.ts";
import { CORE_RULE, FAILURE_RULE, MEMORY_TOOLS, overBudget } from "./memory.ts";
import type { PassJob } from "./passes.ts";

export const INSTRUCTIONS = `You are this agent's reflection. You read what was said lately in one or more of its conversations, each in its own <conversation> tag, and keep its memory true and useful for its future conversations: what it learned about the person, their work and preferences, decisions made, and anything it should do differently next time. Keep only what will still be true and matter in later conversations; leave out one-off details of the task at hand (which file was edited, what was tried along the way). ${FAILURE_RULE} Change memory only with the memory tools; edit what is there before adding new files, keep files short and specific, and leave alone what the conversation did not touch. Read the conversations together: something that comes up in several of them (a preference, a habit, a recurring problem) is evidence that it lasts, even when each mention alone looks passing; and where they disagree, the newer one (the later conversation) wins, and memory should say what changed. Do not link conversations only because they share words: a pattern needs the same thing to recur. ${CORE_RULE} When nothing is worth keeping, change nothing and say so in one line.`;

const WRITES = new Set(MEMORY_TOOLS.filter((t) => t !== "memory_read" && t !== "memory_search"));

export const reflectionJob: PassJob = {
  name: "reflection",
  chatId: (agentId) => `reflection-${agentId}`,
  title: "reflection",
  instructions: INSTRUCTIONS,
  tools: () => MEMORY_TOOLS.map((name) => ({ name })),
  onCompaction: true,
  failedCalls: true,
  prompt: (input) => {
    const said =
      input.parts.length === 1
        ? `Here is what happened in the conversation since you last reflected on it.\n\n${input.material}`
        : `Here is what happened in ${input.parts.length} conversations since you last reflected on them, the one that went quiet first first.\n\n${input.material}`;
    const clashes = input.memoryRoot ? pendingConflicts(input.memoryRoot) : null;
    const withClashes = clashes
      ? `${said}\n\nAlso: your memory was changed on two Macs at once, and ${CONFLICTS_PATH} holds the other side of each clash. For each one, fold what is still true into its note with the memory tools, then delete ${CONFLICTS_PATH}.\n\n<conflicts>\n${clashes}\n</conflicts>`
      : said;
    const over = input.memoryRoot ? overBudget(input.memoryRoot) : null;
    return over ? `${withClashes}\n\n${over}` : withClashes;
  },
  apply: (_input, answer) => ({ items: { memory_changes: answer.toolCalls.filter((t) => WRITES.has(t)).length } }),
};
