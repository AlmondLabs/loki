import { isAbsolute, resolve } from "node:path";
import { configure, defineExtension, defineTool, type ConversationId, type Cursor, type Extension, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { unansweredWhy } from "./chat-events.ts";
import { ChatDoc } from "./kernel/index.ts";
import { withStepDescription } from "./step-description.ts";
import { withKind } from "./tool-kinds.ts";

function assistantText(entry: { kind: string; model?: unknown }): string {
  if (entry.kind !== "pi.assistant" || !Array.isArray(entry.model)) return "";
  const m = entry.model[0] as { role?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
  if (m?.role !== "assistant") return "";
  return (m.content ?? [])
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("")
    .trim();
}

async function lastAssistantText(api: ToolExecutionApi, conversationId: ConversationId, context: Context, cursor?: Cursor): Promise<string> {
  const page = await api.commit((tx) => tx.scanEntries({ conversationId, order: "descending" }, 50, cursor), context);
  for (const entry of page.items) {
    const text = assistantText(entry);
    if (text) return text;
  }
  return page.next === undefined ? "" : lastAssistantText(api, conversationId, context, page.next);
}

export function subagentExtension(withoutAlso: readonly Extension[] = []): Extension {
  const extension: Extension = defineExtension({
    name: "loki.subagents",
    tools: [
      withKind(
        "read",
        withStepDescription(
          defineTool({
            name: "subagent",
            description:
              "Hand a self-contained task to a helper agent and get its final answer back. Give it everything it needs in the prompt: it does not see this conversation.",
            parameters: {
              type: "object",
              properties: {
                prompt: { type: "string" },
                cwd: { type: "string", description: "Optional working folder for the helper (default: this chat's folder)." },
              },
              required: ["prompt"],
            } as never,
            replay: "safe",
            execute: async (args, api, context) => {
              const { prompt, cwd: rawCwd } = args as { prompt: string; cwd?: string };
              const parentAgent = await api.agent(context);
              const resolvedCwd =
                typeof rawCwd === "string" && rawCwd.trim()
                  ? isAbsolute(rawCwd.trim())
                    ? rawCwd.trim()
                    : resolve(parentAgent.cwd ?? process.cwd(), rawCwd.trim())
                  : undefined;
              const parentInfo = await api.snapshot(ChatDoc, api.conversationId, context);
              const child = await api.commit(async (tx) => {
                const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items.at(0);
                if (existing) return existing.id;
                const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
                await configure(tx, created.id, {
                  ...(resolvedCwd ? { cwd: resolvedCwd } : {}),
                  extensions: { remove: [extension, ...withoutAlso] },
                });
                const info = await tx.doc(ChatDoc, created.id);
                Object.assign(info, { id: parentInfo?.id ?? "", hidden: true, helper_for: api.conversationId });
                return created.id;
              }, context);
              await api.details({ conversationId: child }, context);
              const handle = await api.conversation(child, context);
              if (!handle) throw new Error("the helper's conversation is gone");
              const settled = await (await handle.submit({ type: "input", content: prompt, requestId: `subagent:${api.taskId}` }, context)).wait(context);
              if (settled.status !== "done") throw new Error(`the helper did not finish: ${unansweredWhy(settled)}`);
              const answer = await lastAssistantText(api, child, context);
              return { output: [{ type: "text", text: answer || "The helper finished without an answer." }] };
            },
          }),
        ),
      ),
    ],
  });
  return extension;
}
