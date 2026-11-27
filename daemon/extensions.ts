import { defineExtension, wrapTool, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import type { Approvals } from "./approvals.ts";
import { askExtension } from "./ask.ts";
import { backgroundExtension, wrapBashWithBackground, type BackgroundTasks } from "./background.ts";
import { changesExtension } from "./changes.ts";
import { shrinkingProcessor } from "./image-shrink.ts";
import { historyExtension, type ChatHistory } from "./history-tools.ts";
import { memoryExtension } from "./memory.ts";
import { planExtension } from "./plan.ts";
import { readOnlyExtension } from "./read-only-gate.ts";
import { repliesExtension } from "./replies.ts";
import { scheduleExtension, type Schedules } from "./schedule.ts";
import { skillsExtension } from "./skills.ts";
import { withStepDescription } from "./step-description.ts";
import { subagentExtension, type SubagentManager } from "./subagents.ts";
import { CODING_TOOL_KINDS, declaredKind, type ToolKind } from "./tool-kinds.ts";
import { fileToolsExtension } from "./tools.ts";
import { webSearchExtension } from "./web-search.ts";

export interface BuiltinDeps {
  approvals: Approvals;
  backendDir: string;
  background: BackgroundTasks;
  schedules: Schedules;
  history: ChatHistory;
  subagents?: SubagentManager;
  scripts?: readonly Extension[];
}

function describedCodingTools(background: BackgroundTasks): Extension[] {
  const coding = createCodingTools({ images: shrinkingProcessor() });
  const bash: ToolRegistration | undefined = coding.tools?.find((t) => t.name === "bash");
  if (!bash) throw new Error("pi-durable's coding tools have no bash tool");
  return [
    coding,
    defineExtension({
      name: "loki.descriptions",
      wraps: [wrapTool(bash, (t) => withStepDescription(wrapBashWithBackground(t, background)))],
    }),
  ];
}

export function builtinExtensions(deps: BuiltinDeps): Extension[] {
  return [
    deps.approvals.extension(),
    askExtension(deps.approvals),
    planExtension(),
    ...describedCodingTools(deps.background),
    fileToolsExtension(),
    memoryExtension(deps.backendDir),
    skillsExtension(deps.backendDir),
    subagentExtension(deps.subagents),
    webSearchExtension(),
    backgroundExtension(deps.background),
    scheduleExtension(deps.schedules),
    historyExtension(deps.history),
    changesExtension(),
    repliesExtension(),
    readOnlyExtension(deps.backendDir),
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
