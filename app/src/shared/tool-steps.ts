import type { TranscriptRow } from "../../../core/attention/transcript.ts";
import type { IconName } from "./icons";

const SHELL = new Set(["Bash", "bash", "background_run", "BashOutput", "Shell", "run_command", "execute_command", "exec_command", "shell", "local_shell"]);
const EDITS = new Set([
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Write",
  "ApplyPatch",
  "apply_patch",
  "memory_apply_patch",
  "memory",
  "memory_write",
  "memory_edit",
  "memory_delete",
]);
const BACKGROUND = new Set(["background_watch", "TaskOutput", "Monitor", "TaskStop"]);
const isSkillTool = (name: string): boolean => name === "skill" || name === "Skill";
const AGENTS = new Set(["Task", "subagent", "Agent", "SendAgentMessage"]);

export function stepTitle(name: string): string {
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  if (mcp) return `${mcp[1]}.${mcp[2]}`;
  const words = name.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function stepVerb(name: string): string {
  if (name === "Background task") return "Ran in background";
  if (name === "mcp_search") return "Loaded MCP tools";
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  if (mcp) return `Used ${mcp[1]}.${mcp[2]}`;
  if (name === "background_run") return "Started in background";
  if (isSkillTool(name)) return "Loaded skill";
  if (SHELL.has(name)) return "Ran";
  switch (name) {
    case "Read":
      return "Read";
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
    case "ApplyPatch":
    case "apply_patch":
      return "Edited";
    case "memory_apply_patch":
    case "memory":
    case "memory_write":
    case "memory_edit":
    case "memory_delete":
      return "Updated memory";
    case "memory_read":
      return "Read memory";
    case "Write":
      return "Wrote";
    case "Grep":
    case "Glob":
      return "Searched";
    case "WebSearch":
    case "web_search":
      return "Searched the web";
    case "WebFetch":
      return "Fetched";
    case "Task":
    case "subagent":
    case "Agent":
      return "Asked an agent";
    case "SendAgentMessage":
      return "Messaged an agent";
    case "TodoWrite":
    case "UpdatePlan":
      return "Updated the plan";
    case "TaskOutput":
      return "Read a command's output";
    case "background_watch":
    case "Monitor":
      return "Waited on a command";
    case "TaskStop":
      return "Stopped a command";
    case "user_ask":
    case "AskUserQuestion":
      return "Asked you";
    default:
      // Outside (ACP): an agent names a step by its title ("Read signups.csv"), which already says what it did.
      return name.includes(" ") ? name : `Used ${name}`;
  }
}

export function stepIcon(name: string): IconName {
  if (name === "Background task") return "terminal";
  if (isSkillTool(name)) return "skill";
  if (SHELL.has(name) || BACKGROUND.has(name)) return "terminal";
  if (name === "Read" || name === "Write") return "file";
  if (EDITS.has(name)) return "compose";
  if (name === "Grep" || name === "Glob" || name === "WebSearch" || name === "web_search") return "search";
  if (name === "WebFetch") return "link";
  if (AGENTS.has(name)) return "agents";
  return "widget";
}

export function isWorkRow(row: TranscriptRow): boolean {
  return row.role === "tool" || (row.role === "event" && (isBackgroundTask(row) || row.text === "skill loaded"));
}
const isBackgroundTask = (row: TranscriptRow): boolean => row.role === "event" && row.text.startsWith("background task");

export type StepKind = "background" | "command" | "agent" | "skill" | "read" | "edit" | "search" | "web" | "plan" | "tool";

export function stepKind(row: TranscriptRow): StepKind {
  if (row.role === "event") return isBackgroundTask(row) ? "background" : "skill";
  const name = stepName(row);
  if (SHELL.has(name)) return "command";
  if (AGENTS.has(name)) return "agent";
  if (name === "Read") return "read";
  if (EDITS.has(name)) return "edit";
  if (name === "Grep" || name === "Glob") return "search";
  if (name === "WebSearch" || name === "WebFetch" || name === "web_search") return "web";
  if (name === "TodoWrite" || name === "UpdatePlan") return "plan";
  return "tool";
}

export const stepFailed = (row: TranscriptRow): boolean =>
  row.role === "event" ? isBackgroundTask(row) && /\b(failed|error|killed)\b/.test(row.text) : !!row.tool?.failed;

export const stepName = (row: TranscriptRow): string =>
  row.role === "event" ? (isBackgroundTask(row) ? "Background task" : "Skill") : (row.tool?.name ?? row.text.split(" · ")[0].trim());

export function stepTarget(row: TranscriptRow): string | null {
  if (row.role === "event") return row.summary ?? null;
  if (row.tool?.description) return row.tool.description;
  const i = row.text.indexOf(" · ");
  return i >= 0 ? row.text.slice(i + 3).trim() || null : null;
}

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

const NAMED: ReadonlySet<StepKind> = new Set(["background", "command", "agent"]);
export const isNamedStep = (row: TranscriptRow): boolean => NAMED.has(stepKind(row)) || stepFailed(row);

export function workDuration(rows: TranscriptRow[]): string | null {
  const times = rows.map((r) => (r.at ? Date.parse(r.at) : NaN)).filter(Number.isFinite);
  if (times.length < 2) return null;
  const min = Math.round((Math.max(...times) - Math.min(...times)) / 60_000);
  if (min < 1) return null;
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}`;
}

export function workSummary(rows: TranscriptRow[], running = false): string {
  const took = workDuration(rows);
  if (running) return took ? `Working · ${took}` : "Working";
  const only = rows.length === 1 ? rows[0] : null;
  if (only?.tool?.description && stepKind(only) === "command") return `Ran ${only.tool.description}${only.tool.failed ? " · failed" : ""}`;
  const target = only?.role === "tool" && !["command", "background", "agent"].includes(stepKind(only)) ? stepTarget(only) : null;
  if (only && target) {
    const verb = stepVerb(stepName(only));
    return `${verb.endsWith(target) ? verb : `${verb} ${target}`}${stepFailed(only) ? " · failed" : ""}`;
  }
  const count = (k: StepKind) => rows.filter((r) => stepKind(r) === k).length;
  const background = count("background");
  const commands = count("command");
  const tools = rows.length - background - commands;
  const counted = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);
  const nouns = [
    background && counted(background, "a background task", "background tasks"),
    commands && counted(commands, "a command", "commands"),
    tools && counted(tools, "a tool", "tools"),
  ].filter((x): x is string => !!x);
  const verbs = [
    background && `ran ${counted(background, "a background task", "background tasks")}`,
    commands && `ran ${counted(commands, "a command", "commands")}`,
    tools && `used ${counted(tools, "a tool", "tools")}`,
  ]
    .filter((x): x is string => !!x)
    .join(", ");
  const what = took ? `Worked ${took} · ${nouns.join(", ")}` : verbs.charAt(0).toUpperCase() + verbs.slice(1);
  const failed = rows.filter(stepFailed).length;
  return failed ? `${what} · ${failed} failed` : what;
}

export function lastFailure(rows: TranscriptRow[]): number | null {
  for (let k = rows.length - 1; k >= 0; k--) if (stepFailed(rows[k])) return k;
  return null;
}

export function withoutSkillCalls(rows: TranscriptRow[]): TranscriptRow[] {
  const loaded = new Set(rows.filter((r) => r.role === "event" && r.text === "skill loaded").map((r) => r.summary ?? ""));
  return rows.filter((r) => !(r.role === "tool" && isSkillTool(stepName(r)) && !r.tool?.failed && loaded.has(stepTarget(r) ?? "")));
}
