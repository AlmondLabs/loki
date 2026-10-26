import { CONFLICTS_PATH, pendingConflicts } from "./memory-sync.ts";
import { CORE_RULE, MEMORY_TOOLS, overBudget } from "./memory.ts";
import type { PassJob } from "./passes.ts";

/**
 * Reflection (plan 018): one of the background passes (daemon/passes.ts). It keeps an agent's memory true and useful
 * for its future chats from what a chat said since reflection last read it, holding to the passes' one bar: durable,
 * not one-off. It reads a batch of the agent's chats at once (daemon/passes.ts), so what recurs across them counts. It
 * works as the agent in its hidden chat `reflection-<agent>`, offered only the memory tools, so its
 * commits are Reflection's (daemon/memory.ts). It also reads a chat right after its context is compacted.
 */

/** The system instructions of reflection's hidden chat. */
export const INSTRUCTIONS = `You are this agent's reflection. You read what was said lately in one or more of its conversations, each in its own <conversation> tag, and keep its memory true and useful for its future conversations: what it learned about the person, their work and preferences, decisions made, and anything it should do differently next time. Keep only what will still be true and matter in later conversations; leave out one-off details of the task at hand (which file was edited, which command failed, what was tried along the way). Change memory only with the memory tools; edit what is there before adding new files, keep files short and specific, and leave alone what the conversation did not touch. Read the conversations together: something that comes up in several of them (a preference, a habit, a recurring problem) is evidence that it lasts, even when each mention alone looks passing; and where they disagree, the newer one (the later conversation) wins, and memory should say what changed. Do not link conversations only because they share words: a pattern needs the same thing to recur. ${CORE_RULE} When nothing is worth keeping, change nothing and say so in one line.`;

const WRITES = new Set(MEMORY_TOOLS.filter((t) => t !== "memory_read"));

/** Reflection as a PassJob for the runner: it asks with the batch's material as it is, and counts each memory change the agent made as what it wrote. */
export const reflectionJob: PassJob = {
  name: "reflection",
  chatId: (agentId) => `reflection-${agentId}`,
  title: "reflection",
  instructions: INSTRUCTIONS,
  tools: () => MEMORY_TOOLS.map((name) => ({ name })),
  onCompaction: true,
  prompt: (input) => {
    const said =
      input.parts.length === 1
        ? `Here is what happened in the conversation since you last reflected on it.\n\n${input.material}`
        : `Here is what happened in ${input.parts.length} conversations since you last reflected on them, the one that went quiet first first.\n\n${input.material}`;
    // Notes two Macs changed apart (plan 023, U7): each kept this Mac's text, and the other waits in the conflicts note.
    const clashes = input.memoryRoot ? pendingConflicts(input.memoryRoot) : null;
    const withClashes = clashes
      ? `${said}\n\nAlso: your memory was changed on two Macs at once, and ${CONFLICTS_PATH} holds the other side of each clash. For each one, fold what is still true into its note with the memory tools, then delete ${CONFLICTS_PATH}.\n\n<conflicts>\n${clashes}\n</conflicts>`
      : said;
    const over = input.memoryRoot ? overBudget(input.memoryRoot) : null;
    return over ? `${withClashes}\n\n${over}` : withClashes;
  },
  apply: (_input, answer) => ({ items: { memory_changes: answer.toolCalls.filter((t) => WRITES.has(t)).length } }),
};
