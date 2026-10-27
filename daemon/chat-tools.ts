import type { Context } from "@earendil-works/chord";
import { defineTool, type ConversationId, type DocumentReader } from "@earendil-works/pi-durable";
import { withKind, type KindedTool, type ToolKind } from "./tool-kinds.ts";

/**
 * One call of a loki tool, whichever engine the chat runs on (plan 042): what the tool reads the chat through. On
 * loki's own engine it comes from pi-durable's tool API; for a chat on an ACP agent, from the agent's store and the
 * chat that loki's MCP endpoint was called for (daemon/acp/loki-tools.ts).
 */
export interface ChatCall {
  /** The agent's store, for the chat's and the agent's documents (ChatDoc, AgentInfoDoc). */
  read: DocumentReader;
  conversationId: ConversationId;
  /** Unique to this call, for the requests it makes of the person (an ask_user card). */
  callId: string;
  signal: AbortSignal;
  /** Output streamed while the tool runs; dropped where the engine shows none. */
  output: (text: string) => void;
}

/** What a loki tool answers: text for the model, or nothing. */
export interface ChatToolResult {
  output?: Array<{ type: "text"; text: string }>;
}

/**
 * A tool of loki's that runs for any engine's chats (plan 042): memory, schedules, ask_user and the mods' tools. Its
 * kind is the one the approval gate reads on loki's engine; on an ACP agent, a read runs without the agent asking.
 */
export interface ChatTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments, an object schema. */
  parameters: object;
  kind: ToolKind;
  run(args: Record<string, unknown>, call: ChatCall, context: Context): Promise<ChatToolResult>;
}

const NO_SIGNAL = new AbortController().signal;

/** A ChatTool as pi-durable's tool, for loki's own engine. */
export function piTool(tool: ChatTool): KindedTool {
  return withKind(
    tool.kind,
    defineTool({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as never,
      execute: (args, api, context) =>
        tool.run(
          args as Record<string, unknown>,
          { read: api, conversationId: api.conversationId, callId: api.callId, signal: context.abortSignal ?? NO_SIGNAL, output: (text) => api.output(text) },
          context,
        ),
    }),
  );
}
