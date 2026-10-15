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
 * loki's tools as they were named before every name followed docs/style.md's snake_case (October 2026), and their names
 * now: the "always allow" list kept on disk is carried over through this map once. Old chats keep their calls under the
 * old names; what reads history (core/attention, shared/tool-steps.ts) knows both.
 */
export const RENAMED_TOOLS: Readonly<Partial<Record<string, string>>> = {
  Agent: "subagent",
  Skill: "skill",
  AskUserQuestion: "ask_user",
  bash_background: "background_run",
  write_stdin: "background_write",
  TaskOutput: "background_output",
  TaskStop: "background_stop",
  Monitor: "background_watch",
  loki_camera: "desk_camera",
  loki_task: "tasks",
};
