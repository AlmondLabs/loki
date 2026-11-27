import { CONFLICTS_PATH, pendingConflicts } from "./memory-sync.ts";
import { CORE_RULE, FAILURE_RULE, MEMORY_TOOLS, overBudget } from "./memory.ts";
import type { PassJob } from "./passes.ts";

export const INSTRUCTIONS = `You are this agent's reflection. You read what was said lately in one or more of its conversations (each in its own <conversation> tag), along with any recent <reply-edits> and <flow-patterns>, and keep memory true and useful for future conversations.

Priority 1 — User preferences, corrections, and supervision friction:
- Look closely for explicit corrections ("No", "stop", "don't ask", "never", "always", tone or format feedback), repeated nudges to keep going ("continue", "go ahead"), retracted blockers, edited or rejected reply drafts (<reply-edits>), and consistent Flow triage habits (<flow-patterns>).
- Store cross-agent communication, approval, formatting, and collaboration preferences in shared/ (for example shared/preferences.md) and agent-specific rules in system/, written as crisp "when X -> do Y" bullet rules so the agent notices and follows them mid-turn.
- If the person corrected a behavior that already has a rule in memory, tighten or replace that rule so it fires next time; when a newer preference disagrees with an older one, replace the old rule everywhere relevant and say what changed.

Priority 2 — Durable domain facts and tool lessons:
- Keep only what will still be true and matter in later conversations; leave out one-off details of the task at hand (which file was edited, commit hashes, uncommitted local fixes, "draft not sent yet", pending vendor replies, or what was tried along the way). Trim superseded status before adding new lines instead of growing play-by-play task journals.
- ${FAILURE_RULE}

General rules:
- Change memory only with the memory tools; edit what is there before adding new files, keep files short and specific, and leave alone what the conversation did not touch.
- Read the conversations together: something that comes up in several of them (a preference, a habit, a recurring problem) is evidence that it lasts, even when each mention alone looks passing; do not link conversations only because they share words, as a pattern needs the same thing to recur.
- ${CORE_RULE}
- When nothing is worth keeping, change nothing and say so in one line.`;

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
    const withSignals = input.signals
      ? `${said}\n\nAlso: recent preference signals from this agent's replies and Flow triage since the last reflection:\n\n${input.signals}`
      : said;
    const clashes = input.memoryRoot ? pendingConflicts(input.memoryRoot) : null;
    const withClashes = clashes
      ? `${withSignals}\n\nAlso: your memory was changed on two Macs at once, and ${CONFLICTS_PATH} holds the other side of each clash. For each one, fold what is still true into its note with the memory tools, then delete ${CONFLICTS_PATH}.\n\n<conflicts>\n${clashes}\n</conflicts>`
      : withSignals;
    const over = input.memoryRoot ? overBudget(input.memoryRoot, input.sharedMemoryRoot) : null;
    return over ? `${withClashes}\n\n${over}` : withClashes;
  },
  apply: (_input, answer) => ({ items: { memory_changes: answer.toolCalls.filter((t) => WRITES.has(t)).length } }),
};
