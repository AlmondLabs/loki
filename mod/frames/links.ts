import type { ChatMessages } from "../chat-links.ts";
import { errorMessage, fail, reply, type FrameHandlers } from "./context.ts";

export interface LinkDeps {
  messages?: Pick<ChatMessages, "receive" | "put" | "close" | "view" | "setDefault">;
}

const NOT_HERE = "chat links are kept by loki's daemon, not this host";

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
        return reply({ accepted: await deps.messages.close(p.link_id, Boolean(ctx.client.peerId)) });
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
    chat_links_get: () => (deps.messages ? reply(deps.messages.view()) : fail(NOT_HERE)),
    chat_links_default: (p) => (deps.messages ? reply(deps.messages.setDefault(p.duration)) : fail(NOT_HERE)),
  };
}
