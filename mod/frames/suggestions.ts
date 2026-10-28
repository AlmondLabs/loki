import type { Client } from "../server.ts";
import type { Suggestions } from "../suggestions.ts";
import { errorMessage, fail, reply, type FrameHandlers } from "./context.ts";

/**
 * The person's actions on suggestions (plan 047, U2), as frames. They reach the Mac the suggestion's chat lives on
 * (the frame table routes them by chat), which carries each one out and answers with the suggestion as it stands.
 */
export interface SuggestionDeps {
  /** The suggestions of this Mac's chats; absent on a host without the daemon's chat records. */
  suggestions?: Pick<Suggestions, "add" | "decide" | "retarget">;
  /** Who a client is, as a refused action names who acted first (R17): "desktop", "phone", or a paired Mac's name. */
  decidedBy?: (client: Client) => string;
}

const NOT_HERE = "suggestions are kept by loki's daemon, not this host";

/** Who a client is without a host to name it: the phone, another Mac, or this Mac's own window. */
const deviceOf = (client: Client) => (client.deviceId ? "phone" : client.peerId ? "another Mac" : "desktop");

/** The chat a frame names, alone: what a saved draft records as its source. */
const chatOf = (p: { agent_id: string; conversation_id: string }) => ({ agent_id: p.agent_id, conversation_id: p.conversation_id });

/**
 * The suggestion frames: decide (send, draft, reject) and re-point, each recorded for analytics, and add, which the
 * move of Tasks sends to a source chat on this Mac (mod/task-migration.ts).
 */
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
