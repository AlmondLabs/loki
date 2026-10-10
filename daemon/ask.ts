import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { askQuestions } from "../core/attention/content.ts";
import type { Approvals } from "./approvals.ts";
import { AgentInfoDoc, ChatDoc } from "./kernel/index.ts";

/**
 * AskUserQuestion (plan 017, U7): the agent asks the person a few questions with options, shown as a question card on
 * every client following the chat; the first client to answer settles it, and the answers come back as the tool's
 * result. The input and the answers have the shape Letta's tool used (core/attention/content.ts), so the card is the
 * same one.
 */
export function askExtension(approvals: Approvals): Extension {
  return defineExtension({
    name: "loki.ask",
    tools: [
      defineTool({
        name: "AskUserQuestion",
        description:
          "Ask the user one or more questions, each with a short list of options, when you need their choice to go on. They answer in a card; you get their answers back.",
        parameters: {
          type: "object",
          properties: {
            questions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  question: { type: "string" },
                  header: { type: "string", description: "A short label, a few words" },
                  options: { type: "array", items: { type: "object", properties: { label: { type: "string" }, description: { type: "string" } }, required: ["label"] } },
                  multiSelect: { type: "boolean" },
                },
                required: ["question", "options"],
              },
            },
          },
          required: ["questions"],
        } as never,
        execute: async (args, api, context) => {
          const [chat, agent] = await Promise.all([api.snapshot(ChatDoc, api.conversationId, context), api.snapshot(AgentInfoDoc, context)]);
          const input = args as Record<string, unknown>;
          if (!askQuestions(input).length) throw new Error("each question needs its text and at least one option");
          const reply = await approvals.ask<{ answers: Record<string, unknown> }>(
            agent?.id ?? "",
            chat?.id || `conversation-${api.conversationId}`,
            { kind: "question", requestId: `question-${api.callId}`, input },
            context.abortSignal,
          );
          const answers = (reply.answers.answers ?? {}) as Record<string, string>;
          const lines = Object.entries(answers).map(([q, a]) => `"${q}": ${a}`);
          return { content: [{ type: "text", text: lines.length ? `The user answered:\n${lines.join("\n")}` : "The user gave no answers." }] };
        },
      }),
    ],
  });
}
