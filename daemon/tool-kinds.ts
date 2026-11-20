import type { ToolRegistration } from "@earendil-works/pi-durable";

export type ToolKind = "read" | "edit" | "command";

export type KindedTool<T extends ToolRegistration = ToolRegistration> = T & { readonly kind: ToolKind };

export function withKind<T extends ToolRegistration>(kind: ToolKind, tool: T): KindedTool<T> {
  return Object.assign(tool, { kind });
}

export const declaredKind = (tool: ToolRegistration): ToolKind | undefined => ("kind" in tool && isToolKind(tool.kind) ? tool.kind : undefined);

const isToolKind = (v: unknown): v is ToolKind => v === "read" || v === "edit" || v === "command";

export const CODING_TOOL_KINDS: Readonly<Partial<Record<string, ToolKind>>> = { read: "read", write: "edit", edit: "edit", bash: "command" };

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
