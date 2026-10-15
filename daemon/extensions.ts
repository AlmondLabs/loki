import type { Extension } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { Approvals } from "./approvals.ts";
import { askExtension } from "./ask.ts";
import { backgroundExtension, type BackgroundTasks } from "./background.ts";
import { memoryExtension } from "./memory.ts";
import { scheduleExtension, type Schedules } from "./schedule.ts";
import { skillsExtension } from "./skills.ts";
import { subagentExtension } from "./subagents.ts";
import { CODING_TOOL_KINDS, declaredKind, type ToolKind } from "./tool-kinds.ts";
import { fileToolsExtension } from "./tools.ts";
import { webSearchExtension } from "./web-search.ts";

/**
 * What the built-in extensions are made from: the approval gate (which the question card shares), the agents' backend
 * folder for memory and skills, and the background tasks and schedules, which deliver into chats through the daemon.
 */
export interface BuiltinDeps {
  approvals: Approvals;
  backendDir: string;
  background: BackgroundTasks;
  schedules: Schedules;
}

/**
 * Every chat's built-in extensions, in the order they are installed: the permission gate first, so it sees every tool
 * call, then the question card, pi-durable's coding tools (read, write, edit, bash), loki's file tools, memory, skills,
 * helpers (subagents), web search, background tasks and schedules. The mods and MCP servers install after these.
 */
export function builtinExtensions(deps: BuiltinDeps): Extension[] {
  return [
    deps.approvals.extension(),
    askExtension(deps.approvals),
    CodingTools,
    fileToolsExtension(),
    memoryExtension(deps.backendDir),
    skillsExtension(deps.backendDir),
    subagentExtension(),
    webSearchExtension(),
    backgroundExtension(deps.background),
    scheduleExtension(deps.schedules),
  ];
}

/**
 * Each built-in tool's kind, by name, as the tools declare it (`withKind`), and pi-durable's coding tools as
 * CODING_TOOL_KINDS names them. A built-in tool that declares nothing is missing here, which test/extensions.test.ts
 * forbids.
 */
export function builtinKinds(extensions: readonly Extension[]): Map<string, ToolKind> {
  const kinds = new Map<string, ToolKind>();
  for (const extension of extensions)
    for (const tool of extension.tools ?? []) {
      const kind = declaredKind(tool) ?? CODING_TOOL_KINDS[tool.name];
      if (kind) kinds.set(tool.name, kind);
    }
  return kinds;
}
