import type { TranscriptRow } from "../../../core/attention/transcript.ts";
import type { IconName } from "./icons";

/**
 * A stretch of the agent's work read as one quiet line in the thread, the way Claude's apps show them: "Ran 3
 * commands", "Worked 14 min · 10 background tasks, 3 commands, 11 tools · 1 failed", or "Working" while the last
 * step has not come back (workSummary). Opened, each
 * step is a verb and what it was done to ("Ran · ls -la", "Read · app/src/…"), and opened again, its input and
 * output. When the agent said what a call is for (Bash's description), that is the step's line instead
 * ("Ran · Find hard-coded names in tests"), and a lone command's run reads by it. Pure, shared by the phone's
 * sheet and the desktop's inline list (chat/ToolSteps.tsx).
 */

/** Tools that run a shell command: they count as commands, the rest as tools. */
const SHELL = new Set(["Bash", "BashOutput", "Shell", "run_command", "execute_command"]);

/** What a step did, as the list's first line. */
export function stepVerb(name: string): string {
  if (name === "Background task") return "Ran in background";
  if (name === "Skill") return "Loaded skill";
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
  if (name === "Background task") return "terminal";
  if (name === "Skill") return "skill";
  if (SHELL.has(name)) return "terminal";
  if (name === "Read" || name === "Write") return "file";
  if (name === "Edit" || name === "MultiEdit" || name === "NotebookEdit") return "compose";
  if (name === "Grep" || name === "Glob" || name === "WebSearch") return "search";
  if (name === "WebFetch") return "link";
  if (name === "Task" || name === "Agent") return "agents";
  if (name === "Skill") return "skill";
  return "widget";
}

/** A row the agent's work is made of: a tool call, a background task's notice, or a skill it loaded. */
export function isWorkRow(row: TranscriptRow): boolean {
  return row.role === "tool" || (row.role === "event" && (isBackgroundTask(row) || row.text === "skill loaded"));
}
const isBackgroundTask = (row: TranscriptRow): boolean => row.role === "event" && row.text.startsWith("background task");

/** What kind of step a work row is: the ones with a name of their own are listed; the rest are housekeeping. */
export type StepKind = "background" | "command" | "agent" | "skill" | "read" | "edit" | "search" | "web" | "plan" | "tool";

export function stepKind(row: TranscriptRow): StepKind {
  if (row.role === "event") return isBackgroundTask(row) ? "background" : "skill";
  const name = stepName(row);
  if (SHELL.has(name)) return "command";
  if (name === "Task" || name === "Agent") return "agent";
  if (name === "Read") return "read";
  if (name === "Edit" || name === "MultiEdit" || name === "NotebookEdit" || name === "Write") return "edit";
  if (name === "Grep" || name === "Glob") return "search";
  if (name === "WebSearch" || name === "WebFetch") return "web";
  if (name === "TodoWrite" || name === "UpdatePlan") return "plan";
  return "tool";
}

/** Whether a step failed: a tool's result said so, or a background task's notice did. */
export const stepFailed = (row: TranscriptRow): boolean => (row.role === "event" ? isBackgroundTask(row) && /\b(failed|error|killed)\b/.test(row.text) : !!row.tool?.failed);

/** A tool row's name: its step's, or (rows from before steps were kept) the label's head. */
export const stepName = (row: TranscriptRow): string => (row.role === "event" ? (isBackgroundTask(row) ? "Background task" : "Skill") : (row.tool?.name ?? row.text.split(" · ")[0].trim()));

/** The step's second line: what the agent said it is for, else what it was done to (the label's tail), or nothing. */
export function stepTarget(row: TranscriptRow): string | null {
  if (isBackgroundTask(row)) return row.summary?.match(/"([^"]+)"/)?.[1] ?? row.summary ?? null;
  if (row.role === "event") return row.summary ?? null;
  if (row.tool?.description) return row.tool.description;
  const i = row.text.indexOf(" · ");
  return i >= 0 ? row.text.slice(i + 3).trim() || null : null;
}


/**
 * Where each stretch of work starts, from row `from`, and where it ends (exclusive): consecutive tool calls,
 * background-task notices and skill loads are one stretch; a message, another event (canvas activity, a
 * compaction) or a mark ends it.
 */
export function toolRuns(rows: TranscriptRow[], from = 0, breaks?: (i: number) => boolean): Map<number, number> {
  const runs = new Map<number, number>();
  for (let i = from; i < rows.length; i++) {
    if (!isWorkRow(rows[i])) continue;
    let j = i + 1;
    while (j < rows.length && isWorkRow(rows[j]) && !breaks?.(j)) j++;
    runs.set(i, j);
    i = j - 1;
  }
  return runs;
}

/** Steps with a name of their own, shown in full; everything else is housekeeping, listed quieter. */
const NAMED: ReadonlySet<StepKind> = new Set(["background", "command", "agent"]);
export const isNamedStep = (row: TranscriptRow): boolean => NAMED.has(stepKind(row)) || stepFailed(row);

/** "14 min", "1 h 5 min"; null under a minute, or when the rows carry no times. */
export function workDuration(rows: TranscriptRow[]): string | null {
  const times = rows.map((r) => (r.at ? Date.parse(r.at) : NaN)).filter(Number.isFinite);
  if (times.length < 2) return null;
  const min = Math.round((Math.max(...times) - Math.min(...times)) / 60_000);
  if (min < 1) return null;
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}`;
}

/**
 * The stretch's one line: how long the agent worked, what it ran, and what failed. "Worked 14 min · 10 background
 * tasks, 3 commands, 11 tools · 1 failed"; a lone described command reads by its description, as before; "Working"
 * while the last step has not come back.
 */
export function workSummary(rows: TranscriptRow[], running = false): string {
  const took = workDuration(rows);
  if (running) return took ? `Working · ${took}` : "Working";
  const only = rows.length === 1 ? rows[0] : null;
  if (only?.tool?.description && stepKind(only) === "command") return `Ran ${only.tool.description}${only.tool.failed ? " · failed" : ""}`;
  const count = (k: StepKind) => rows.filter((r) => stepKind(r) === k).length;
  const background = count("background");
  const commands = count("command");
  const tools = rows.length - background - commands;
  const counted = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);
  const nouns = [background && counted(background, "a background task", "background tasks"), commands && counted(commands, "a command", "commands"), tools && counted(tools, "a tool", "tools")].filter((x): x is string => !!x);
  const verbs = [background && `ran ${counted(background, "a background task", "background tasks")}`, commands && `ran ${counted(commands, "a command", "commands")}`, tools && `used ${counted(tools, "a tool", "tools")}`].filter((x): x is string => !!x).join(", ");
  const what = took ? `Worked ${took} · ${nouns.join(", ")}` : verbs.charAt(0).toUpperCase() + verbs.slice(1);
  const failed = rows.filter(stepFailed).length;
  return failed ? `${what} · ${failed} failed` : what;
}

/** The last step that failed, by its name: shown under the closed line so a failure needs no click to notice. */
export function lastFailure(rows: TranscriptRow[]): number | null {
  for (let k = rows.length - 1; k >= 0; k--) if (stepFailed(rows[k])) return k;
  return null;
}
