import { configure, defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { ChatDoc } from "./kernel/index.ts";

/**
 * Subagents (plan 017, U10, KTD12): the Agent tool hands a self-contained task to a helper that runs in a child
 * conversation the call owns, with the parent's model, tools and folder, and returns the helper's final answer.
 * Aborting the call aborts the helper; a rerun after a crash finds the same child (the call is replay-safe). The child
 * carries the parent chat's identity and permission mode, so its approvals ask in the chat you are looking at and its
 * tools act on that chat's canvas. A helper cannot start helpers of its own.
 */
export function subagentExtension(): Extension {
  const extension: Extension = defineExtension({
    name: "loki.subagents",
    tools: [
      defineTool({
        name: "Agent",
        description:
          "Hand a self-contained task to a helper agent and get its final answer back. Give it everything it needs in the prompt: it does not see this conversation.",
        parameters: { type: "object", properties: { description: { type: "string", description: "A few words naming the task" }, prompt: { type: "string" } }, required: ["prompt"] } as never,
        replay: "safe",
        execute: async (args, api, context) => {
          const { prompt } = args as { prompt: string };
          const parentInfo = await api.snapshot(ChatDoc, api.conversationId, context);
          const child = await api.commit(async (tx) => {
            // The ownership index remembers the child, so a rerun reuses it.
            const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
            if (existing) return existing.id;
            const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
            await configure(tx, created.id, { extensions: { remove: [extension] } });
            const info = await tx.doc(ChatDoc, created.id);
            if (parentInfo) Object.assign(info, { ...parentInfo, hidden: true });
            return created.id;
          }, context);
          await api.details({ conversationId: child }, context); // lets a client attach to the child
          const handle = await api.conversation(child, context);
          if (!handle) throw new Error("the helper's conversation is gone");
          const settled = await (await handle.submit({ type: "input", content: prompt, requestId: `subagent:${api.taskId}` }, context)).wait(context);
          if (settled.status !== "done") throw new Error(`the helper did not finish: ${settled.status}`);
          const answer = await api.commit(async (tx) => {
            for (const entry of (await tx.scanEntries({ conversationId: child }, 50)).items) {
              const m = entry.model?.[0] as { role?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
              if (entry.kind === "pi.assistant" && m?.role === "assistant") {
                const text = (m.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join("").trim();
                if (text) return text;
              }
            }
            return "";
          }, context);
          return { content: [{ type: "text", text: answer || "The helper finished without an answer." }] };
        },
      }),
    ],
  });
  return extension;
}
