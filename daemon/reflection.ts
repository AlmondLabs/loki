import { CONFLICTS_PATH, pendingConflicts } from "./memory-sync.ts";
import { CORE_BUDGET, coreSize, MEMORY_TOOLS } from "./memory.ts";
import type { PassJob } from "./passes.ts";

/**
 * Reflection (plan 018): one of the background passes (daemon/passes.ts). It keeps an agent's memory true and useful
 * for its future chats from what a chat said since reflection last read it, holding to the passes' one bar: durable,
 * not one-off. It reads a batch of the agent's chats at once (daemon/passes.ts), so what recurs across them counts. It
 * works as the agent in its hidden chat `reflection-<agent>`, offered only the memory tools, so its
 * commits are Reflection's (daemon/memory.ts). It also reads a chat right after its context is compacted.
 */

/** The system instructions of reflection's hidden chat. */
export const INSTRUCTIONS = `You are this agent's reflection. You read what was said lately in one or more of its conversations, each in its own <conversation> tag, and keep its memory true and useful for its future conversations: what it learned about the person, their work and preferences, decisions made, and anything it should do differently next time. Keep only what will still be true and matter in later conversations; leave out one-off details of the task at hand (which file was edited, which command failed, what was tried along the way). Change memory only with the memory tools; edit what is there before adding new files, keep files short and specific, and leave alone what the conversation did not touch. Read the conversations together: something that comes up in several of them (a preference, a habit, a recurring problem) is evidence that it lasts, even when each mention alone looks passing; and where they disagree, the newer one (the later conversation) wins, and memory should say what changed. Do not link conversations only because they share words: a pattern needs the same thing to recur. Your core notes (system/) are in every conversation in full, so keep them to who you are, who the person is and how they like to work, and rules that hold for any task; a project's or a tool's conventions and gotchas go in a note outside system/. Every note outside system/ starts with front matter whose description says in one line when the note is worth reading (---, description: …, ---): the conversation sees that line, not the note, so write it as when to read, not as a title, and add one to a note you write or edit that has none. When nothing is worth keeping, change nothing and say so in one line.`;

const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;

/**
 * The paragraph that asks reflection to bring the core back within CORE_BUDGET (plan 034), naming its biggest notes;
 * null while it fits. A large core takes a few runs: each run moves some, and the next one sees what is left.
 */
export function overBudget(root: string): string | null {
  const size = coreSize(root);
  if (!size || size.bytes <= CORE_BUDGET) return null;
  const biggest = size.files.slice(0, 5).map((f) => `- ${f.path} (${kb(f.bytes)})`);
  return `Also: your core notes (system/) come to ${kb(size.bytes)}, over their budget of ${kb(CORE_BUDGET)}. Move what is not needed in every conversation into notes outside system/, each with a description, leaving at most a line in its place. The biggest:\n${biggest.join("\n")}`;
}

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
