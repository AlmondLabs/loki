import { MEMORY_TOOLS } from "./memory.ts";
import type { PassJob } from "./passes.ts";

/**
 * Reflection (plan 018): one of the background passes (daemon/passes.ts). It keeps an agent's memory true and useful
 * for its future chats from what a chat said since reflection last read it, holding to the passes' one bar: durable,
 * not one-off. It reads a batch of the agent's chats at once (daemon/passes.ts), so what recurs across them counts. It
 * works as the agent in its hidden chat `reflection-<agent>`, offered only the memory tools, so its
 * commits are Reflection's (daemon/memory.ts). It also reads a chat right after its context is compacted.
 */

export const INSTRUCTIONS = `You are this agent's reflection. You read what was said lately in one or more of its conversations, each in its own <conversation> tag, and keep its memory true and useful for its future conversations: what it learned about the person, their work and preferences, decisions made, and anything it should do differently next time. Keep only what will still be true and matter in later conversations; leave out one-off details of the task at hand (which file was edited, which command failed, what was tried along the way). Change memory only with the memory tools; edit what is there before adding new files, keep files short and specific, and leave alone what the conversation did not touch. Read the conversations together: something that comes up in several of them (a preference, a habit, a recurring problem) is evidence that it lasts, even when each mention alone looks passing; and where they disagree, the newer one (the later conversation) wins, and memory should say what changed. Do not link conversations only because they share words: a pattern needs the same thing to recur. When nothing is worth keeping, change nothing and say so in one line.`;

const WRITES = new Set(MEMORY_TOOLS.filter((t) => t !== "memory_read"));

export const reflectionJob: PassJob = {
  name: "reflection",
  chatId: (agentId) => `reflection-${agentId}`,
  title: "reflection",
  instructions: INSTRUCTIONS,
  tools: () => MEMORY_TOOLS.map((name) => ({ name })),
  onCompaction: true,
  prompt: (input) =>
    input.parts.length === 1
      ? `Here is what happened in the conversation since you last reflected on it.\n\n${input.material}`
      : `Here is what happened in ${input.parts.length} conversations since you last reflected on them, the one that went quiet first first.\n\n${input.material}`,
  apply: (_input, answer) => ({ items: { memory_changes: answer.toolCalls.filter((t) => WRITES.has(t)).length } }),
};
