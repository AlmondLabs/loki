import type { TranscriptRow } from "../../../core/attention/transcript.ts";
import type { IconName } from "./icons";

export type StepKind = "background" | "command" | "agent" | "skill" | "read" | "edit" | "search" | "web" | "plan" | "tool";

interface Entry {
  readonly verb: string;
  readonly tag: string;
  readonly icon: IconName;
  readonly kind: StepKind;
  readonly path?: boolean;
  readonly url?: boolean;
  readonly untitled?: string;
}

const entry = (verb: string, tag: string, icon: IconName, kind: StepKind, more: Partial<Entry> = {}): Entry => ({ verb, tag, icon, kind, ...more });

const RAN = entry("Ran", "Ran", "terminal", "command");
const WAITED = entry("Waited on a command", "Waited", "terminal", "tool", { untitled: "A command" });
const EDITED = entry("Edited", "Edited", "pencil", "edit", { path: true });
const MEMORY_EDIT = entry("Updated memory", "Memory", "pencil", "edit", { path: true });
const AGENT = entry("Asked an agent", "Agent", "bot", "agent");
const ASKED = entry("Asked you", "Asked you", "question", "tool");
const SKILL = entry("Read skill", "Skill", "skill", "skill");
const PLAN = entry("Updated the plan", "Plan", "checklist", "plan");
const DRAFT = entry("Drafted a message", "Draft", "mail", "tool");

const CATALOGUE: Readonly<Partial<Record<string, Entry>>> = {
  bash: RAN,
  Bash: RAN,
  Shell: RAN,
  shell: RAN,
  local_shell: RAN,
  exec_command: RAN,
  run_command: RAN,
  execute_command: RAN,
  background_run: entry("Started in background", "Started", "terminal", "command"),
  "Background task": entry("Ran in background", "Finished", "checklist", "background"),
  background_watch: WAITED,
  Monitor: WAITED,
  BashOutput: entry("Read a command's output", "Waited", "terminal", "command", { untitled: "A command" }),
  TaskOutput: entry("Read a command's output", "Waited", "terminal", "tool", { untitled: "A command" }),
  TaskStop: entry("Stopped a command", "Stopped", "terminal", "tool", { untitled: "A command" }),
  read: entry("Read", "Read", "file", "read", { path: true }),
  Read: entry("Read", "Read", "file", "read", { path: true }),
  write: entry("Wrote", "Wrote", "file", "edit", { path: true }),
  Write: entry("Wrote", "Wrote", "file", "edit", { path: true }),
  edit: EDITED,
  Edit: EDITED,
  MultiEdit: EDITED,
  NotebookEdit: EDITED,
  apply_patch: EDITED,
  ApplyPatch: EDITED,
  memory_read: entry("Read memory", "Memory", "file", "read", { path: true }),
  memory_search: entry("Searched memory", "Memory", "search", "read"),
  memory_write: MEMORY_EDIT,
  memory_edit: MEMORY_EDIT,
  memory_delete: MEMORY_EDIT,
  memory_apply_patch: MEMORY_EDIT,
  memory: MEMORY_EDIT,
  ls: entry("Listed", "Listed", "folder", "search", { path: true }),
  find: entry("Found", "Found", "search", "search"),
  Glob: entry("Searched", "Found", "search", "search"),
  grep: entry("Searched", "Searched", "search", "search"),
  Grep: entry("Searched", "Searched", "search", "search"),
  web_search: entry("Searched the web", "Web", "globe", "web"),
  web_fetch: entry("Fetched", "Fetched", "globe", "web", { url: true }),
  WebSearch: entry("Searched the web", "Web", "globe", "web"),
  WebFetch: entry("Fetched", "Fetched", "globe", "web", { url: true }),
  subagent: AGENT,
  subagent_status: entry("Checked an agent", "Agent", "bot", "agent", { untitled: "An agent" }),
  subagent_stop: entry("Stopped an agent", "Stopped", "bot", "agent", { untitled: "An agent" }),
  Task: AGENT,
  Agent: AGENT,
  SendAgentMessage: entry("Messaged an agent", "Agent", "bot", "agent"),
  user_ask: ASKED,
  AskUserQuestion: ASKED,
  codemode: entry("Ran a script", "Script", "code", "tool", { untitled: "A script" }),
  script: entry("Ran a script", "Script", "code", "tool", { untitled: "A script" }),
  skill: SKILL,
  Skill: SKILL,
  suggestion_create: entry("Suggested work", "Suggested", "learn", "tool"),
  chat_message: entry("Messaged a chat", "Message", "desk", "tool"),
  reply_propose: DRAFT,
  message_propose: DRAFT,
  ticket_propose: entry("Proposed a ticket", "Ticket", "ticket", "tool"),
  mcp_search: entry("Loaded MCP tools", "Tools", "wrench", "tool"),
  plan: PLAN,
  TodoWrite: PLAN,
  UpdatePlan: PLAN,
  update_plan: PLAN,
};

const ACP_KINDS: Readonly<Partial<Record<string, Entry>>> = {
  read: entry("Read", "Read", "file", "read", { path: true }),
  edit: EDITED,
  delete: entry("Deleted", "Deleted", "pencil", "edit", { path: true }),
  move: entry("Moved", "Moved", "pencil", "edit", { path: true }),
  execute: RAN,
  search: entry("Searched", "Searched", "search", "search"),
  fetch: entry("Fetched", "Fetched", "globe", "web", { url: true }),
  think: entry("Thought", "Thought", "brain", "tool"),
};

const MCP = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/;

export const nameAsWords = (name: string): string => {
  const words = name.replace(/_+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const isAgentTitle = (name: string): boolean => name.includes(" ");

const unprefixLoki = (name: string): string => (name.startsWith("mcp__loki__") ? name.slice("mcp__loki__".length) : name);

function entryOf(name: string, acpKind?: string): Entry {
  const listed = CATALOGUE[name] ?? CATALOGUE[unprefixLoki(name)];
  if (listed) return listed;
  const acp = acpKind ? ACP_KINDS[acpKind] : undefined;
  if (acp) return acp;
  const mcp = MCP.exec(name);
  if (mcp) return entry(`Used ${mcp[1]}.${mcp[2]}`, nameAsWords(mcp[1]), "wrench", "tool");
  if (isAgentTitle(name)) return entry(name, "Tool", "wrench", "tool");
  return entry(`Used ${nameAsWords(name).toLowerCase()}`, "Tool", "wrench", "tool");
}

const ACP_SKILL = /^Load skill: (.+)$/;
const SKILL_FILE = /[\\/]([^\\/]+)[\\/]SKILL\.md$/;

function skillOf(row: TranscriptRow): string | null {
  if (row.role !== "tool") return null;
  const name = stepName(row);
  const acp = ACP_SKILL.exec(name);
  if (acp) return acp[1].trim();
  if (entryOf(name, row.tool?.acp_kind).kind !== "read") return null;
  return SKILL_FILE.exec(plainTarget(row) ?? "")?.[1] ?? null;
}

const entryOfRow = (row: TranscriptRow): Entry => (skillOf(row) ? SKILL : entryOf(stepName(row), row.tool?.acp_kind));

export function stepTitle(name: string): string {
  const mcp = MCP.exec(name);
  if (mcp) return `${mcp[1]}.${mcp[2]}`;
  return nameAsWords(name);
}

export const stepVerb = (name: string): string => entryOf(name).verb;

export const stepVerbOf = (row: TranscriptRow): string => entryOfRow(row).verb;

export const stepIcon = (name: string): IconName => entryOf(name).icon;

export const stepIconOf = (row: TranscriptRow): IconName => entryOfRow(row).icon;

const untitledOf = (name: string, e: Entry): string => {
  if (e.untitled) return e.untitled;
  const mcp = MCP.exec(name);
  if (mcp) return nameAsWords(mcp[2]);
  return isAgentTitle(name) ? name : nameAsWords(name);
};

const fileName = (path: string): string =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || path;
const withFolder = (path: string): string =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .slice(-2)
    .join("/");
const withoutScheme = (url: string): string => url.replace(/^[a-z]+:\/\//i, "").replace(/\/$/, "");

export interface StepLine {
  title: string;
  tag: string;
  icon: IconName;
  full: string;
}

function lineOf(row: TranscriptRow): StepLine & { path: string | null } {
  const name = stepName(row);
  const e = entryOfRow(row);
  const failed = stepFailed(row);
  const tag = failed ? "Failed" : e.tag;
  const icon: IconName = failed ? "close" : e.icon;
  const target = stepTarget(row);
  const described = row.role === "tool" && !!row.tool?.description;
  if (!target) {
    const title = untitledOf(name, e);
    return { title, tag, icon, full: title, path: null };
  }
  const oneLine = target.split("\n")[0];
  if (!described && e.path) return { title: fileName(oneLine), tag, icon, full: oneLine, path: oneLine };
  if (!described && e.url) return { title: withoutScheme(oneLine), tag, icon, full: oneLine, path: null };
  return { title: oneLine, tag, icon, full: oneLine, path: null };
}

export function stepLines(rows: readonly TranscriptRow[]): StepLine[] {
  const lines = rows.map(lineOf);
  const names = new Map<string, Set<string>>();
  for (const l of lines) if (l.path) names.set(l.title, (names.get(l.title) ?? new Set()).add(l.path));
  return lines.map(({ path, ...l }) => (path && (names.get(l.title)?.size ?? 0) > 1 ? { ...l, title: withFolder(path) } : l));
}

export const stepLine = (row: TranscriptRow): StepLine => stepLines([row])[0];

export function isWorkRow(row: TranscriptRow): boolean {
  return row.role === "tool" || (row.role === "event" && (isBackgroundTask(row) || row.text === "skill loaded"));
}
const isBackgroundTask = (row: TranscriptRow): boolean => row.role === "event" && row.text.startsWith("background task");

export function stepKind(row: TranscriptRow): StepKind {
  if (row.role === "event") return isBackgroundTask(row) ? "background" : "skill";
  return entryOfRow(row).kind;
}

export const stepFailed = (row: TranscriptRow): boolean =>
  row.role === "event" ? isBackgroundTask(row) && /\b(failed|error|killed)\b/.test(row.text) : !!row.tool?.failed;

export const stepName = (row: TranscriptRow): string =>
  row.role === "event" ? (isBackgroundTask(row) ? "Background task" : "Skill") : (row.tool?.name ?? row.text.split(" · ")[0].trim());

function plainTarget(row: TranscriptRow): string | null {
  if (row.role === "event") return row.summary ?? null;
  if (row.tool?.description) return row.tool.description;
  const i = row.text.indexOf(" · ");
  return i >= 0 ? row.text.slice(i + 3).trim() || null : null;
}

export const stepTarget = (row: TranscriptRow): string | null => skillOf(row) ?? plainTarget(row);

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
  if (only?.tool?.description) return `${only.tool.description}${stepFailed(only) ? " · failed" : ""}`;
  const target = only?.role === "tool" && !["command", "background", "agent"].includes(stepKind(only)) ? stepTarget(only) : null;
  if (only && target) {
    const verb = entryOfRow(only).verb;
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
