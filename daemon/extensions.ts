import type { Extension } from "@earendil-works/pi-durable";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import type { Approvals } from "./approvals.ts";
import { askExtension } from "./ask.ts";
import { backgroundExtension, type BackgroundTasks } from "./background.ts";
import { changesExtension } from "./changes.ts";
import { shrinkingProcessor } from "./image-shrink.ts";
import { historyExtension, type ChatHistory } from "./history-tools.ts";
import { memoryExtension } from "./memory.ts";
import { repliesExtension } from "./replies.ts";
import { scheduleExtension, type Schedules } from "./schedule.ts";
import { skillsExtension } from "./skills.ts";
import { subagentExtension } from "./subagents.ts";
import { CODING_TOOL_KINDS, declaredKind, type ToolKind } from "./tool-kinds.ts";
import { fileToolsExtension } from "./tools.ts";
import { webSearchExtension } from "./web-search.ts";

export interface BuiltinDeps {
  approvals: Approvals;
  backendDir: string;
  background: BackgroundTasks;
  schedules: Schedules;
  history: ChatHistory;
  scripts?: readonly Extension[];
}

export function builtinExtensions(deps: BuiltinDeps): Extension[] {
  return [
    deps.approvals.extension(),
    askExtension(deps.approvals),
    createCodingTools({ images: shrinkingProcessor() }),
    fileToolsExtension(),
    memoryExtension(deps.backendDir),
    skillsExtension(deps.backendDir),
    subagentExtension(deps.scripts),
    webSearchExtension(),
    backgroundExtension(deps.background),
    scheduleExtension(deps.schedules),
    historyExtension(deps.history),
    changesExtension(),
    repliesExtension(),
    ...(deps.scripts ?? []),
  ];
}

export function builtinKinds(extensions: readonly Extension[]): Map<string, ToolKind> {
  const kinds = new Map<string, ToolKind>();
  for (const extension of extensions)
    for (const tool of extension.tools ?? []) {
      const kind = declaredKind(tool) ?? CODING_TOOL_KINDS[tool.name];
      if (kind) kinds.set(tool.name, kind);
    }
  return kinds;
}
