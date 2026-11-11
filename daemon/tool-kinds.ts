import type { ToolRegistration } from "@earendil-works/pi-durable";

/**
 * What a tool does, for the permission modes (daemon/approvals.ts): reads, edits files, or anything else (a command).
 * Each of loki's own tools says which on its definition (`withKind`), a mod's tool or an MCP server's says so in its
 * annotations, and pi-durable's four coding tools are named here; a tool that says nothing is a command, the kind that
 * asks most.
 */
export type ToolKind = "read" | "edit" | "command";

/** A tool of loki's, with the kind it declares. */
export type KindedTool<T extends ToolRegistration = ToolRegistration> = T & { readonly kind: ToolKind };

/**
 * A tool definition with its kind beside it, for the approval gate. The field rides on the registration only: pi-durable
 * passes nothing but pi-ai's own tool fields to the model.
 */
export function withKind<T extends ToolRegistration>(kind: ToolKind, tool: T): KindedTool<T> {
  return Object.assign(tool, { kind });
}

/** Whether a registered tool declared its kind with `withKind`. */
export const declaredKind = (tool: ToolRegistration): ToolKind | undefined => ("kind" in tool && isToolKind(tool.kind) ? tool.kind : undefined);

const isToolKind = (v: unknown): v is ToolKind => v === "read" || v === "edit" || v === "command";

/** pi-durable's coding tools (CodingTools), whose definitions loki cannot annotate. */
export const CODING_TOOL_KINDS: Readonly<Partial<Record<string, ToolKind>>> = { read: "read", write: "edit", edit: "edit", bash: "command" };

/**
 * loki's tools as they were once named, and their names now: before every name followed docs/style.md's snake_case
 * (October 2026), and before every name was `<subject>_<verb>` (plan 044). The "always allow" list kept on disk is
 * carried over through this map once, and each store's saved calls and results are renamed once
 * (daemon/store-migration.ts), so nothing that reads history knows an old name.
 */
export const RENAMED_TOOLS: Readonly<Partial<Record<string, string>>> = {
  Agent: "subagent",
  Skill: "skill",
  AskUserQuestion: "user_ask",
  ask_user: "user_ask",
  bash_background: "background_run",
  Monitor: "background_watch",
  loki_camera: "canvas_focus",
  desk_camera: "canvas_focus",
  desk_state: "canvas_read",
  view_image: "image_view",
};

/** The task tools, one per action of the old `tasks` tool (plan 044). */
const TASK_TOOLS: Readonly<Partial<Record<string, string>>> = { create: "task_create", list: "task_list", comment: "task_comment", close: "task_close" };

/** Old tools that became one tool per action: their `action` argument names the tool now (plan 044). */
export const SPLIT_TOOLS: Readonly<Partial<Record<string, Readonly<Partial<Record<string, string>>>>>> = { tasks: TASK_TOOLS, loki_task: TASK_TOOLS };

/** An old tool now done by another tool's call (plan 095): which tool, and its call's arguments from the old ones. */
export interface MergedTool {
  readonly into: string;
  readonly args: (old: Record<string, unknown>) => Record<string, unknown>;
  /**
   * Whether "always allow" for the old tool carries over to the one it is now: only when the old tool could ask
   * outside strict mode (a command), so a carried allow never lets more through than the person allowed.
   */
  readonly carriesAlways: boolean;
}

const WATCH_OUTPUT: MergedTool = { into: "background_watch", args: (a) => ({ ...a, timeout_ms: 0 }), carriesAlways: false };
const WATCH_WRITE: MergedTool = {
  into: "background_watch",
  args: ({ text, ...rest }) => ({ ...rest, ...(text === undefined ? {} : { input: text }), timeout_ms: 0 }),
  carriesAlways: true,
};
const WATCH_STOP: MergedTool = { into: "background_watch", args: (a) => ({ ...a, stop: true }), carriesAlways: true };

/**
 * Old tools merged into another (plan 095): the background task's output, input and stop are `background_watch`
 * calls now, under loki's names and the older ones they had (`TaskOutput`, `write_stdin`, `TaskStop`).
 */
export const MERGED_TOOLS: Readonly<Partial<Record<string, MergedTool>>> = {
  background_output: WATCH_OUTPUT,
  TaskOutput: WATCH_OUTPUT,
  background_write: WATCH_WRITE,
  write_stdin: WATCH_WRITE,
  background_stop: WATCH_STOP,
  TaskStop: WATCH_STOP,
};

/** Whether a tool name is an old one: renamed, split or merged. */
export const isOldTool = (name: string): boolean => name in RENAMED_TOOLS || name in SPLIT_TOOLS || name in MERGED_TOOLS;

/**
 * The tools an "always allow" under a name carries to now: one for a rename, each action's tool for a split one, the
 * merged tool when the old one was a command (else none), itself for a name still in use.
 */
export const renamedTools = (name: string): string[] => {
  const split = SPLIT_TOOLS[name];
  if (split) return Object.values(split).filter((n): n is string => !!n);
  const merged = MERGED_TOOLS[name];
  if (merged) return merged.carriesAlways ? [merged.into] : [];
  return [RENAMED_TOOLS[name] ?? name];
};

/**
 * A call under an old name as it is now: renamed, for a split tool the action's own tool without its `action`
 * argument, or for a merged one the tool it is now with its arguments carried over. Null when the name is current, or a split tool's action is not one it had.
 */
export function renamedCall(name: string, args: Record<string, unknown>): { name: string; args: Record<string, unknown> } | null {
  const split = SPLIT_TOOLS[name];
  if (split) {
    const { action, ...rest } = args;
    const now = typeof action === "string" ? split[action] : undefined;
    return now ? { name: now, args: rest } : null;
  }
  const merged = MERGED_TOOLS[name];
  if (merged) return { name: merged.into, args: merged.args(args) };
  const now = RENAMED_TOOLS[name];
  return now ? { name: now, args } : null;
}

/** Whether a value is a plain object. */
export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Rename the tool calls and results in `messages` in place: a call under an old name takes its name now (a split
 * tool's, its action's tool), and a result takes its call's, found in `calls` by the call's id, which this fills as it
 * goes; a result whose call it never saw takes a plain rename. True when anything changed.
 */
export function renameToolsIn(messages: readonly unknown[], calls: Map<string, string>): boolean {
  let changed = false;
  for (const m of messages) {
    if (!isRecord(m)) continue;
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const part of m.content as unknown[]) {
        if (!isRecord(part) || part.type !== "toolCall" || typeof part.name !== "string") continue;
        const now = renamedCall(part.name, isRecord(part.arguments) ? part.arguments : {});
        if (!now) continue;
        part.name = now.name;
        part.arguments = now.args;
        if (typeof part.id === "string") calls.set(part.id, now.name);
        changed = true;
      }
    } else if (m.role === "toolResult" && typeof m.toolName === "string") {
      const now = (typeof m.toolCallId === "string" ? calls.get(m.toolCallId) : undefined) ?? RENAMED_TOOLS[m.toolName] ?? MERGED_TOOLS[m.toolName]?.into;
      if (now && now !== m.toolName) {
        m.toolName = now;
        changed = true;
      }
    }
  }
  return changed;
}
