import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { defineTool, type ConversationId, type DocumentReader } from "@earendil-works/pi-durable";
import { withKind, type KindedTool, type ToolKind } from "./tool-kinds.ts";

export interface ChatCall {
  read: DocumentReader;
  conversationId: ConversationId;
  callId: string;
  signal: AbortSignal;
  output: (text: string) => void;
  cwd?: string;
}

export interface ChatToolResult {
  output?: Array<{ type: "text"; text: string }>;
  structuredOutput?: JsonValue;
}

export interface ChatTool {
  name: string;
  description: string;
  parameters: object;
  kind: ToolKind;
  forAgent?: (agentId: string) => boolean;
  callers?: ReadonlyArray<"model" | "tools">;
  replay?: "safe";
  outputSchema?: object;
  run(args: Record<string, unknown>, call: ChatCall, context: Context): Promise<ChatToolResult>;
}

const NO_SIGNAL = new AbortController().signal;

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
