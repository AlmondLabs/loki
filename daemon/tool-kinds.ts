import type { ToolRegistration } from "@earendil-works/pi-durable";

export type ToolKind = "read" | "edit" | "command";

export type KindedTool<T extends ToolRegistration = ToolRegistration> = T & { readonly kind: ToolKind };

export function withKind<T extends ToolRegistration>(kind: ToolKind, tool: T): KindedTool<T> {
  return Object.assign(tool, { kind });
}

export const declaredKind = (tool: ToolRegistration): ToolKind | undefined => ("kind" in tool && isToolKind(tool.kind) ? tool.kind : undefined);

const isToolKind = (v: unknown): v is ToolKind => v === "read" || v === "edit" || v === "command";

export const CODING_TOOL_KINDS: Readonly<Partial<Record<string, ToolKind>>> = { read: "read", write: "edit", edit: "edit", bash: "command" };

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

const TASK_TOOLS: Readonly<Partial<Record<string, string>>> = { create: "task_create", list: "task_list", comment: "task_comment", close: "task_close" };

export const SPLIT_TOOLS: Readonly<Partial<Record<string, Readonly<Partial<Record<string, string>>>>>> = { tasks: TASK_TOOLS, loki_task: TASK_TOOLS };

export interface MergedTool {
  readonly into: string;
  readonly args: (old: Record<string, unknown>) => Record<string, unknown>;
  readonly carriesAlways: boolean;
}

const WATCH_OUTPUT: MergedTool = { into: "background_watch", args: (a) => ({ ...a, timeout_ms: 0 }), carriesAlways: false };
const WATCH_WRITE: MergedTool = {
  into: "background_watch",
  args: ({ text, ...rest }) => ({ ...rest, ...(text === undefined ? {} : { input: text }), timeout_ms: 0 }),
  carriesAlways: true,
};
const WATCH_STOP: MergedTool = { into: "background_watch", args: (a) => ({ ...a, stop: true }), carriesAlways: true };

export const MERGED_TOOLS: Readonly<Partial<Record<string, MergedTool>>> = {
  background_output: WATCH_OUTPUT,
  TaskOutput: WATCH_OUTPUT,
  background_write: WATCH_WRITE,
  write_stdin: WATCH_WRITE,
  background_stop: WATCH_STOP,
  TaskStop: WATCH_STOP,
};

export const isOldTool = (name: string): boolean => name in RENAMED_TOOLS || name in SPLIT_TOOLS || name in MERGED_TOOLS;

export const renamedTools = (name: string): string[] => {
  const split = SPLIT_TOOLS[name];
  if (split) return Object.values(split).filter((n): n is string => !!n);
  const merged = MERGED_TOOLS[name];
  if (merged) return merged.carriesAlways ? [merged.into] : [];
  return [RENAMED_TOOLS[name] ?? name];
};

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

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

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
