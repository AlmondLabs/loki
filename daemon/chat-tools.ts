import type { Context, JsonValue } from "@earendil-works/chord";
import { defineTool, type ConversationId, type DocumentReader } from "@earendil-works/pi-durable";
import { withKind, type KindedTool, type ToolKind } from "./tool-kinds.ts";

/**
 * One call of a loki tool, whichever engine the chat runs on (plan 044): what the tool reads the chat through. On
 * loki's own engine it comes from pi-durable's tool API; for a chat on an ACP agent, from the agent's store and the
 * chat that loki's MCP endpoint was called for (daemon/acp/loki-tools.ts).
 */
export interface ChatCall {
  /** The agent's store, for the chat's and the agent's documents (ChatDoc, AgentInfoDoc). */
  read: DocumentReader;
  conversationId: ConversationId;
  /** Unique to this call, for the requests it makes of the person (a user_ask card). */
  callId: string;
  signal: AbortSignal;
  /** Output streamed while the tool runs; dropped where the engine shows none. */
  output: (text: string) => void;
  /** The chat's folder on loki's engine; an ACP chat's call has none. */
  cwd?: string;
}

/** What a loki tool answers: text for the model, or nothing. */
export interface ChatToolResult {
  output?: Array<{ type: "text"; text: string }>;
  /** The value scripts get, for a tool with an `outputSchema`. */
  structuredOutput?: JsonValue;
}

/**
 * A tool of loki's that runs for any engine's chats (plan 044): memory, schedules, user_ask and the mods' tools. Its
 * kind is the one the approval gate reads on loki's engine; on an ACP agent, a read runs without the agent asking.
 */
export interface ChatTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments, an object schema. */
  parameters: object;
  kind: ToolKind;
  /** Whether a chat of this agent is offered the tool (a mod's `forAgent`, plan 067); absent, every agent's. */
  forAgent?: (agentId: string) => boolean;
  /** Who may call it (ModTool.callers); `["tools"]` is script-only and never listed for an ACP chat. */
  callers?: ReadonlyArray<"model" | "tools">;
  /** `"safe"`: a call cut off by a restart may run again (ModTool.replay). */
  replay?: "safe";
  /** JSON Schema of `structuredOutput` (ModTool.outputSchema). */
  outputSchema?: object;
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
      ...(tool.callers ? { callers: tool.callers } : {}),
      ...(tool.replay ? { replay: tool.replay } : {}),
      ...(tool.outputSchema ? { structuredOutputSchema: tool.outputSchema } : {}),
      execute: async (args, api, context) => {
        const { cwd } = await api.agent(context);
        return tool.run(
          args,
          {
            read: api,
            conversationId: api.conversationId,
            callId: api.callId,
            signal: context.abortSignal ?? NO_SIGNAL,
            output: (text) => api.output(text),
            ...(cwd === undefined ? {} : { cwd }),
          },
          context,
        );
      },
    }),
  );
}
