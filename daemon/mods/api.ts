/**
 * loki's mod API, version 1 (plan 017, KTD17). A mod adds tools, prompt sections, a say before a tool runs, a
 * transform of the person's message before it is sent, and listens to turn events. The daemon turns each mod into one
 * pi-durable extension (daemon/mods/registry.ts), so its tools and hooks reach every chat of every agent, and editing a
 * mod reloads it in place.
 *
 * The shape grew out of the Letta mod API loki was written against (mod/letta-types.ts): `tools.register`,
 * `events.on`, `diagnostics.report` and `signal` keep their names. Parameters are JSON Schema, as there.
 */

/** The API's major version. A mod built for a newer one is refused (registry.ts). */
export const MOD_API_VERSION = 1;

/** Which chat and agent a call, a section or an event belongs to: loki's own ids. */
export type ChatRef = { chatId: string; agentId: string; agentName: string };

export type ToolContext = ChatRef & {
  signal: AbortSignal;
  /** Stream running output; the returned text, when there is any, replaces it as the result. */
  output(text: string): void;
};

export type ModTool = {
  name: string;
  description: string;
  /** JSON Schema for the arguments, an object schema. */
  parameters: object;
  /** Hints for permission modes (plan 017, U7): read-only tools never ask; destructive ones may. */
  annotations?: { readOnly?: boolean; destructive?: boolean };
  execute(args: Record<string, unknown>, ctx: ToolContext): unknown;
};

export type SectionInput = ChatRef & { cwd: string | undefined };

/** A tool call about to run: block it with a reason the model sees, or change its arguments. */
export type ToolCall = ChatRef & { name: string; args: Record<string, unknown>; signal: AbortSignal };
export type BeforeToolResult = { block: string } | { args: Record<string, unknown> } | undefined;

/** The person's message as it is about to be sent: return new content to replace it, nothing to leave it. */
export type OutgoingMessage = ChatRef & { content: string | Array<Record<string, unknown>>; typed: boolean };

export type ModEvents = {
  /** A chat was opened in a client (U5). */
  chat_open: ChatRef;
  /** A run ended with the model's final answer. */
  turn_end: ChatRef;
  /** A tool call started, and ended with its status. */
  tool_start: ChatRef & { name: string; args: unknown };
  tool_end: ChatRef & { name: string; failed: boolean };
  /** A chat's context was compacted. */
  compact_end: ChatRef;
};

type Unregister = () => void;

export interface ModApi {
  readonly apiVersion: typeof MOD_API_VERSION;
  tools: { register(tool: ModTool): Unregister };
  prompt: { section(key: string, render: (input: SectionInput) => string | undefined | Promise<string | undefined>): Unregister };
  message: { transform(handler: (message: OutgoingMessage) => OutgoingMessage["content"] | undefined): Unregister };
  beforeTool(handler: (call: ToolCall) => BeforeToolResult | Promise<BeforeToolResult>): Unregister;
  events: { on<K extends keyof ModEvents>(name: K, handler: (event: ModEvents[K]) => void): Unregister };
  diagnostics: { report(d: { severity: "info" | "warning" | "error"; message: string }): void };
  /** Aborted when the mod is unloaded or replaced. */
  readonly signal: AbortSignal;
}

/** A mod as a module exports it. `activate` may return a function that undoes what it did. */
export type LokiMod = {
  name: string;
  apiVersion: number;
  activate(api: ModApi): void | Unregister | Promise<void | Unregister>;
};
