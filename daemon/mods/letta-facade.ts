import type { ModApi, LokiMod } from "./api.ts";

/**
 * loki's own mod (mod/index.ts) was written against Letta's mod API, and runs there until the cutover (plan 017,
 * U15). In the daemon it gets that API's shape on top of loki's mod API, so the same code serves both: its tools,
 * its `turn_start` rider on the person's message, and the events it listens to. The cutover moves the mod onto
 * ModApi itself and this file goes.
 */

type Handler = (event: unknown, ctx: { agent: { id: string; name: string }; conversation: { id: string } }) => unknown;
type LettaTool = { name: string; description: string; parameters: object; run(ctx: { args: Record<string, unknown>; conversation: { id: string }; agent: { id: string; name: string } }): unknown };

/** A Letta-shaped host over `api`. */
export function lettaFacade(api: ModApi) {
  const ctxOf = (ref: { chatId: string; agentId: string; agentName: string }) => ({ agent: { id: ref.agentId, name: ref.agentName }, conversation: { id: ref.chatId } });
  return {
    // Not a terminal session's harness: the mod serves its ports here (mod/gate.ts).
    capabilities: { commands: false, tools: true, events: { turns: true, lifecycle: false } },
    tools: {
      register: (tool: LettaTool) =>
        api.tools.register({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          execute: async (args, ctx) => {
            const out = await tool.run({ args, ...ctxOf(ctx) });
            // Letta's failed result, as a failed tool call.
            if (out && typeof out === "object" && (out as { status?: unknown }).status === "error") throw new Error(String((out as { content?: unknown }).content ?? "the tool failed"));
            return out;
          },
        }),
    },
    commands: { register: () => () => {} },
    events: {
      on: (name: string, handler: Handler): (() => void) => {
        switch (name) {
          case "turn_start":
            // Letta hands the turn's input items and takes back `{ input }`; here the input is the person's message.
            return api.message.transform((m) => {
              const input = [{ role: "user", content: m.content }];
              const result = handler({ agentId: m.agentId, conversationId: m.chatId, input }, ctxOf(m)) as { input?: Array<{ content?: unknown }> } | undefined;
              return result?.input?.at(-1)?.content as typeof m.content | undefined;
            });
          case "turn_end":
          case "compact_end":
            return api.events.on(name, (e) => void handler({ agentId: e.agentId, conversationId: e.chatId }, ctxOf(e)));
          case "conversation_open":
            return api.events.on("chat_open", (e) => void handler({ agentId: e.agentId, agentName: e.agentName, conversationId: e.chatId, reason: "resume" }, ctxOf(e)));
          case "tool_start":
            return api.events.on("tool_start", (e) => void handler({ toolName: e.name, args: e.args }, ctxOf(e)));
          case "tool_end":
            return api.events.on("tool_end", (e) => void handler({ toolName: e.name, status: e.failed ? "error" : "success" }, ctxOf(e)));
          default:
            return () => {};
        }
      },
    },
    diagnostics: api.diagnostics,
    signal: api.signal,
  };
}

/** A mod written for Letta's API, as a loki mod named `name`; `extras` join the host (the daemon's `chats`). */
export function fromLettaMod(name: string, activate: (host: ReturnType<typeof lettaFacade>) => unknown, extras: Record<string, unknown> = {}): LokiMod {
  return {
    name,
    apiVersion: 1,
    activate: async (api) => {
      const dispose = await activate({ ...lettaFacade(api), ...extras });
      return typeof dispose === "function" ? (dispose as () => void) : undefined;
    },
  };
}
