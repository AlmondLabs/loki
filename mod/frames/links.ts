import type { ChatMessages } from "../chat-links.ts";
import { errorMessage, fail, reply, type FrameHandlers } from "./context.ts";

/**
 * Chat links (plan 067) as frames: a message arriving along a link, another Mac's copy of a link, closing one, and
 * Preferences' list and default duration. The frame table routes the first three to the Mac the chat they name lives
 * on, which checks and keeps its own links.
 */
export interface LinkDeps {
  /** The links of this Mac's chats; absent on a host without the daemon's chats. */
  messages?: Pick<ChatMessages, "receive" | "put" | "close" | "view" | "setDefault">;
}

const NOT_HERE = "chat links are kept by loki's daemon, not this host";

/** The link frames. */
export function linkFrames(deps: LinkDeps): FrameHandlers {
  return {
    chat_message: async (p) => {
      if (!deps.messages) return fail(NOT_HERE);
      const out = await deps.messages.receive({ type: "chat_message", ...p });
      return out.ok ? reply({ accepted: true }) : fail(out.message);
    },
    chat_link_put: (p) => {
      if (!deps.messages) return fail(NOT_HERE);
      deps.messages.put(p.link);
      return reply({ accepted: true });
    },
    chat_link_close: async (p, ctx) => {
      if (!deps.messages) return fail(NOT_HERE);
      try {
        // A close another Mac passed on is not passed back.
        return reply({ accepted: await deps.messages.close(p.link_id, Boolean(ctx.client.peerId)) });
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
    chat_links_get: () => (deps.messages ? reply(deps.messages.view()) : fail(NOT_HERE)),
    chat_links_default: (p) => (deps.messages ? reply(deps.messages.setDefault(p.duration)) : fail(NOT_HERE)),
  };
}
