import type { TranscriptRow } from "../../../core/attention/transcript.ts";
import type { IconName } from "./icons";

/**
 * A run of tool calls read as one quiet line in the thread, the way Claude's apps show them: "Ran 3 commands",
 * "Ran a command, used 9 tools (1 failed)", or "Running" while the last one has not come back. Opened, each
 * step is a verb and what it was done to ("Ran · ls -la", "Read · app/src/…"), and opened again, its input and
 * output. Pure, shared by the phone's sheet and the desktop's inline list (chat/ToolSteps.tsx).
 */

/** Tools that run a shell command: they count as commands, the rest as tools. */
const SHELL = new Set(["Bash", "BashOutput", "Shell", "run_command", "execute_command"]);

/** What a step did, as the list's first line. */
export function stepVerb(name: string): string {
  if (SHELL.has(name)) return "Ran";
  switch (name) {
    case "Read":
      return "Read";
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return "Edited";
    case "Write":
      return "Wrote";
    case "Grep":
    case "Glob":
      return "Searched";
    case "WebSearch":
      return "Searched the web";
    case "WebFetch":
      return "Fetched";
    case "Task":
    case "Agent":
      return "Asked an agent";
    case "TodoWrite":
      return "Updated the plan";
    case "Skill":
      return "Used a skill";
    case "AskUserQuestion":
      return "Asked you";
    default:
      return `Used ${name}`;
  }
}

/** The step's icon in the list. */
export function stepIcon(name: string): IconName {
  if (SHELL.has(name)) return "terminal";
  if (name === "Read" || name === "Write") return "file";
  if (name === "Edit" || name === "MultiEdit" || name === "NotebookEdit") return "compose";
  if (name === "Grep" || name === "Glob" || name === "WebSearch") return "search";
  if (name === "WebFetch") return "link";
  if (name === "Task" || name === "Agent") return "agents";
  if (name === "Skill") return "skill";
  return "widget";
}

/** A tool row's name: its step's, or (rows from before steps were kept) the label's head. */
export const stepName = (row: TranscriptRow): string => row.tool?.name ?? row.text.split(" · ")[0].trim();

/** The step's second line: what it was done to (the label's tail), or nothing to add. */
export function stepTarget(row: TranscriptRow): string | null {
  const i = row.text.indexOf(" · ");
  return i >= 0 ? row.text.slice(i + 3).trim() || null : null;
}

/**
 * The line for a run: commands first ("Ran a command", "Ran 3 commands"), then the other tools ("used 9 tools"),
 * then how many failed; "Running" while the run is the thread's last and its last step has not come back.
 */
export function stepsSummary(rows: TranscriptRow[], running = false): string {
  if (running) return "Running";
  const commands = rows.filter((r) => SHELL.has(stepName(r))).length;
  const tools = rows.length - commands;
  const failed = rows.filter((r) => r.tool?.failed).length;
  const parts: string[] = [];
  if (commands) parts.push(commands === 1 ? "ran a command" : `ran ${commands} commands`);
  if (tools) parts.push(tools === 1 ? "used a tool" : `used ${tools} tools`);
  const line = parts.join(", ");
  const said = line.charAt(0).toUpperCase() + line.slice(1);
  return failed ? `${said} (${failed} failed)` : said;
}

/** Where each run of consecutive tool rows starts, from row `from`, and where it ends (exclusive); a mark stops a run. */
export function toolRuns(rows: TranscriptRow[], from = 0, breaks?: (i: number) => boolean): Map<number, number> {
  const runs = new Map<number, number>();
  for (let i = from; i < rows.length; i++) {
    if (rows[i].role !== "tool") continue;
    let j = i + 1;
    while (j < rows.length && rows[j].role === "tool" && !breaks?.(j)) j++;
    runs.set(i, j);
    i = j - 1;
  }
  return runs;
}
