import { CORE_RULE, MEMORY_TOOLS } from "./memory.ts";

/**
 * The memory review (`/doctor`), Letta's /doctor on loki: the agent reads all of its own memory at once and cleans it
 * up, in its hidden `doctor-<agent>` chat, on the background passes' runner (PassRunner.runDoctor), so it never edits
 * memory while reflection or Learn does. Where reflection adds what new conversations taught, the review looks only at
 * what memory already says: it tidies (duplicates, size, one-off details) and makes the judgement calls (stale facts,
 * contradictions, a persona that drifted). It edits directly through the memory tools, each change a commit by
 * "Doctor"; the Agents page's Changes lists them, and Revert undoes one.
 */

/** The memory review's instructions to the agent, as the PassRunner's doctor pass sends them. */
export const DOCTOR_INSTRUCTIONS = `You are this agent's memory doctor. You review all of the agent's own memory, the files shown to you, and clean it up so that it is true, short and easy to use in later conversations. Change memory only with the memory tools, one change per call, each with a short message saying why ("merge two notes on deploys", "drop the 30 Sept deadline, it has passed").

Tidy:
- Merge files or passages that say the same thing; keep the clearest wording and delete what the merge made redundant.
- Split a file that mixes unrelated subjects, or has grown too long to scan; merge tiny files on one subject.
- Remove one-off details of past tasks that will not matter again (which file was edited, which command failed, what was tried along the way).
- Fix formatting that gets in the way (broken lists, headings that no longer match their content).
- Keep the core small: ${CORE_RULE}

Judge:
- Stale facts: dates that have passed, projects that are finished, plans that were replaced. Keep what still matters as history in one line; remove the rest.
- Contradictions: where two places disagree, keep the newer or more specific one and say what changed. When you cannot tell which is right, keep both and mark the conflict in one line rather than guessing.
- Persona drift: where the persona or instructions no longer match how the agent is described elsewhere in its memory, bring them back in line. Do not invent a new personality.

Never remove something only because it is old: what the person told you about themselves, their preferences and their decisions stays unless memory itself shows it changed. Do not add facts from outside memory. Leave alone what is fine; a review that changes nothing is a good result.

When you are done, answer with a short report for the person: one line per change (what and why), then one line on anything you left for them to decide. If you changed nothing, say in one line that memory looks healthy.`;

/** The tools a review may use: every memory tool, delete included. */
export const DOCTOR_TOOLS = MEMORY_TOOLS;

/** The review's hidden chat for an agent; its prefix is how memory.ts names the commits' author. */
export const doctorChatId = (agentId: string): string => `doctor-${agentId}`;

/** What the review is asked: the date (so it can tell what has passed), every memory file, and when the core is over its budget, that (memory.ts overBudget). */
export function doctorPrompt(dump: { text: string; files: number; chars: number }, now: Date, over: string | null = null): string {
  const memory = `Today is ${now.toISOString().slice(0, 10)}. Here is all of your memory: ${dump.files} file${dump.files === 1 ? "" : "s"}, ${dump.chars} characters.\n\n${dump.text}`;
  return over ? `${memory}\n\n${over}` : memory;
}
