import type { Client } from "../server.ts";
import type { ReplyProposals } from "../reply-proposals.ts";
import { errorMessage, fail, reply, type FrameHandlers } from "./context.ts";

/**
 * The person's action on a reply an agent proposed (plan 067, U10, KTD9), as a frame. It reaches the Mac the chat lives
 * on, which holds the account, writes the draft there on approve and answers with the proposal as it stands.
 */
export interface ReplyDeps {
  /** This Mac's reply proposals; absent on a host without the Inbox accounts. */
  replies?: Pick<ReplyProposals, "decide">;
  /** Who a client is, as a refused action names who acted first: "desktop", "phone", or a paired Mac's name. */
  decidedBy?: (client: Client) => string;
}

/** Who a client is without a host to name it: the phone, another Mac, or this Mac's own window. */
const deviceOf = (client: Client) => (client.deviceId ? "phone" : client.peerId ? "another Mac" : "desktop");

/** The reply frame: approve (with the text as edited, and whether to replace a draft already there) or reject. */
export function replyFrames(deps: ReplyDeps): FrameHandlers {
  const by = deps.decidedBy ?? deviceOf;
  return {
    reply_decide: async (p, ctx) => {
      if (!deps.replies) return fail("replies are kept by loki's daemon, not this host");
      const who = by(ctx.client);
      try {
        const out = await deps.replies.decide({ agent_id: p.agent_id, conversation_id: p.conversation_id }, p.proposal_id, p.action, who, {
          text: p.text,
          replace: p.replace,
        });
        return reply(out);
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
  };
}
