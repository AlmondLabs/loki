import type { Client } from "../server.ts";
import type { Suggestions } from "../suggestions.ts";
import { errorMessage, fail, reply, type FrameHandlers } from "./context.ts";

export interface SuggestionDeps {
  suggestions?: Pick<Suggestions, "decide" | "retarget">;
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
        return reply(out);
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
    suggestion_retarget: async (p) => {
      if (!deps.suggestions) return fail(NOT_HERE);
      try {
        const out = await deps.suggestions.retarget(chatOf(p), p.suggestion_id, p.target);
        return reply(out);
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
  };
}
