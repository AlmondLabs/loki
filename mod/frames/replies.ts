import type { Client } from "../server.ts";
import type { ReplyProposals } from "../reply-proposals.ts";
import { errorMessage, fail, reply, type FrameHandlers } from "./context.ts";

export interface ReplyDeps {
  replies?: Pick<ReplyProposals, "decide" | "findPeople">;
  decidedBy?: (client: Client) => string;
}

const deviceOf = (client: Client) => (client.deviceId ? "phone" : client.peerId ? "another Mac" : "desktop");

export function replyFrames(deps: ReplyDeps): FrameHandlers {
  const by = deps.decidedBy ?? deviceOf;
  return {
    reply_decide: async (p, ctx) => {
      if (!deps.replies) return fail("replies are kept by loki's daemon, not this host");
      const who = by(ctx.client);
      try {
        const out = await deps.replies.decide({ agent_id: p.agent_id, conversation_id: p.conversation_id }, p.proposal_id, p.action, who, {
          text: p.text,
          files: p.files,
          mentions: p.mentions,
        });
        return reply(out);
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
    reply_people_find: async (p) => {
      if (!deps.replies) return fail("replies are kept by loki's daemon, not this host");
      try {
        return reply(await deps.replies.findPeople({ agent_id: p.agent_id, conversation_id: p.conversation_id }, p.proposal_id, p.query));
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
  };
}
