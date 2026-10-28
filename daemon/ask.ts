import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import { askQuestions } from "../core/attention/content.ts";
import type { Approvals } from "./approvals.ts";
import { AgentInfoDoc, ChatDoc } from "./kernel/index.ts";
import { piTool, type ChatTool } from "./chat-tools.ts";

/**
 * user_ask (plan 017, U7; `ask_user` until plan 044): the agent asks the person a few questions with options, shown as a question card on
 * every client following the chat; the first client to answer settles it, and the answers come back as the tool's
 * result. The input and the answers have the shape the question card reads (core/attention/content.ts).
 */
export function askTool(approvals: Approvals): ChatTool {
  return {
    kind: "read",
    name: "user_ask",
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
              options: {
                type: "array",
                items: { type: "object", properties: { label: { type: "string" }, description: { type: "string" } }, required: ["label"] },
              },
              multi_select: { type: "boolean" },
            },
            required: ["question", "options"],
          },
        },
      },
      required: ["questions"],
    },
    run: async (args, call, context) => {
      const [chat, agent] = await Promise.all([call.read.snapshot(ChatDoc, call.conversationId, context), call.read.snapshot(AgentInfoDoc, context)]);
      const input = args;
      if (!askQuestions(input).length) throw new Error("each question needs its text and at least one option");
      const reply = await approvals.ask<{ answers: Record<string, unknown> }>(
        agent?.id ?? "",
        chat?.id || `conversation-${call.conversationId}`,
        { kind: "question", request_id: `question-${call.callId}`, input },
        call.signal,
      );
      const answers = (reply.answers.answers ?? {}) as Record<string, string>;
      const lines = Object.entries(answers).map(([q, a]) => `"${q}": ${a}`);
      return { output: [{ type: "text", text: lines.length ? `The user answered:\n${lines.join("\n")}` : "The user gave no answers." }] };
    },
  };
}

/** user_ask as an extension, for loki's own engine. */
export function askExtension(approvals: Approvals): Extension {
  return defineExtension({ name: "loki.ask", tools: [piTool(askTool(approvals))] });
}
