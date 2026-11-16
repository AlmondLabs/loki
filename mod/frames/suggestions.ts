import type { Client } from "../server.ts";
import type { Suggestions } from "../suggestions.ts";
import { errorMessage, fail, reply, type FrameHandlers } from "./context.ts";

export interface SuggestionDeps {
  suggestions?: Pick<Suggestions, "add" | "decide" | "retarget">;
  decidedBy?: (client: Client) => string;
}

const NOT_HERE = "suggestions are kept by loki's daemon, not this host";

const deviceOf = (client: Client) => (client.deviceId ? "phone" : client.peerId ? "another Mac" : "desktop");

const chatOf = (p: { agent_id: string; conversation_id: string }) => ({ agent_id: p.agent_id, conversation_id: p.conversation_id });

export function suggestionFrames(deps: SuggestionDeps): FrameHandlers {
  const by = deps.decidedBy ?? deviceOf;
  return {
    suggestion_decide: async (p, ctx) => {
      if (!deps.suggestions) return fail(NOT_HERE);
      const who = by(ctx.client);
      try {
        const out = await deps.suggestions.decide(chatOf(p), p.suggestion_id, p.action, who);
        ctx.track("suggestion_decided", { action: p.action, outcome: out.done ? "done" : "refused", by: who });
        return reply(out);
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
    suggestion_add: async (p) => {
      if (!deps.suggestions) return fail(NOT_HERE);
      try {
        const input = { title: p.title, text: p.text, target: p.target };
        return reply({ suggestion: await deps.suggestions.add(chatOf(p), input, p.suggestion_id ? { id: p.suggestion_id } : {}) });
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
    suggestion_retarget: async (p, ctx) => {
      if (!deps.suggestions) return fail(NOT_HERE);
      try {
        const out = await deps.suggestions.retarget(chatOf(p), p.suggestion_id, p.target);
        ctx.track("suggestion_decided", { action: "retarget", outcome: out.done ? "done" : "refused", by: by(ctx.client) });
        return reply(out);
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
  };
}
