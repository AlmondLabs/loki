import type { Pushes } from "../../core/frames.ts";
import type { SeenStore } from "../seen.ts";
import type { FrameHandlers } from "./context.ts";

export interface SeenDeps {
  seen?: SeenStore;
}

/** The done and viewed marks and the focus weights, as one push: the one place it is built (the turn-start mark too). */
export function seenFrame(deps: SeenDeps): { type: "seen" } & Pushes["seen"] {
  const { seen } = deps;
  return { type: "seen", seen: seen?.all() ?? {}, viewed: seen?.viewedAll() ?? {}, focus: seen?.focusAll() ?? {} };
}

/** The marks the Inbox and the sidebar read: done, not done, a look, and engagements the mod cannot see. A mark that moves nothing is not broadcast. */
export function seenFrames(deps: SeenDeps): FrameHandlers {
  const { seen } = deps;
  return {
    seen_list: (_, ctx) => ctx.push(seenFrame(deps)),
    seen_mark: ({ agentId, conversationId }, ctx) => {
      const moved = seen?.mark(agentId, conversationId);
      ctx.track("conversation_marked_seen");
      if (moved) ctx.broadcast(seenFrame(deps));
    },
    seen_unmark: ({ agentId, conversationId }, ctx) => {
      const moved = seen?.unmark(agentId, conversationId);
      ctx.track("conversation_kept_unread");
      if (moved) ctx.broadcast(seenFrame(deps));
    },
    // Not tracked: a look happens on every open, it is not a decision.
    viewed_mark: ({ agentId, conversationId }, ctx) => {
      const looked = seen?.view(agentId, conversationId);
      const engaged = seen?.engage(agentId, conversationId, "open"); // opening and reading is engagement too
      if (looked || engaged) ctx.broadcast(seenFrame(deps));
    },
    // Messages are counted at turn_start (every surface, the terminal too); opens at viewed_mark. What is left: answers and decisions.
    focus_add: ({ agentId, conversationId, action }, ctx) => {
      if (seen?.engage(agentId, conversationId, action)) ctx.broadcast(seenFrame(deps));
    },
  };
}
