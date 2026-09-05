/** Minimal structural types for the Letta mod API surface loci uses (no .d.ts ships with letta-code). */

export interface ConversationHandle {
  id: string | null;
  sendMessageStream(
    messages: Array<{ role: "user"; content: string }>,
    options?: Record<string, unknown>,
  ): Promise<AsyncIterable<Record<string, unknown>>>;
  getHistory?(options?: { limit?: number; order?: "asc" | "desc" }): Promise<Array<Record<string, unknown>>>;
}

export interface EventContext {
  conversation?: ConversationHandle;
}

export interface CommandContext {
  conversation?: ConversationHandle;
  agent?: { id?: string; name?: string };
}

export type CommandResult =
  | { type: "output"; output: string }
  /** Send text into the conversation as if the user typed it. */
  | { type: "prompt"; content: string; systemReminder?: boolean };

export interface ToolRunContext {
  args: Record<string, unknown>;
  /** The conversation the tool call was made from (Letta passes the full handle). */
  conversation?: ConversationHandle;
  agent?: { id?: string; name?: string };
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: object;
  requiresApproval?: boolean;
  parallelSafe?: boolean;
  run(ctx: ToolRunContext): Promise<unknown> | unknown;
}

export interface TurnStartEvent {
  agentId: string | null;
  conversationId: string | null;
  input: Array<Record<string, unknown>>;
}

export interface ConversationOpenEvent {
  agentId: string | null;
  agentName: string | null;
  conversationId: string | null;
  reason: "startup" | "new" | "resume" | "fork";
}

export interface LettaMod {
  capabilities?: {
    commands?: boolean;
    tools?: boolean;
    events?: { turns?: boolean; lifecycle?: boolean } | boolean;
  };
  tools?: { register(tool: ToolDefinition): (() => void) | void };
  commands: {
    register(command: {
      id: string;
      description: string;
      run(ctx: CommandContext): Promise<CommandResult> | CommandResult;
    }): (() => void) | void;
  };
  events?: {
    on(name: string, handler: (event: unknown, ctx: EventContext) => unknown): (() => void) | void;
  };
  diagnostics?: { report(d: { message: string; severity: "info" | "warning" | "error" }): void };
  signal?: AbortSignal;
}
