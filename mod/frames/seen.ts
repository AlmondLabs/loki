import type { Pushes } from "../../core/frames.ts";
import type { SeenStore } from "../seen.ts";
import type { FrameHandlers } from "./context.ts";

/** What the marks' frame handler needs from its host: the marks store, absent when the mod keeps none. */
export interface SeenDeps {
  seen?: SeenStore;
}

/** The done and viewed marks, the focus weights and the rests, as one push: the one place it is built (the turn-start mark too). */
export function seenFrame(deps: SeenDeps): { type: "seen" } & Pushes["seen"] {
  const { seen } = deps;
  return { type: "seen", seen: seen?.all() ?? {}, viewed: seen?.viewedAll() ?? {}, focus: seen?.focusAll() ?? {}, rests: seen?.restsAll() ?? {} };
}

/** One chat's marks, after a change to that chat alone (plan 055): a few hundred bytes, not every chat's. */
export function seenChatFrame(seen: SeenStore, agentId: string | null, conversationId: string): { type: "seen_chat" } & Pushes["seen_chat"] {
  return { type: "seen_chat", ...seen.chat(agentId, conversationId) };
}

/** The marks the Inbox and the sidebar read: done, not done, a look, and engagements the mod cannot see. A mark that moves nothing is not broadcast, and one
 * that does sends only its chat's marks. */
export function seenFrames(deps: SeenDeps): FrameHandlers {
  const { seen } = deps;
  return {
    seen_list: (_, ctx) => ctx.push(seenFrame(deps)),
    seen_mark: ({ agent_id: agentId, conversation_id: conversationId }, ctx) => {
      const moved = seen?.mark(agentId, conversationId);
      ctx.track("conversation_marked_seen");
      if (moved && seen) ctx.broadcast(seenChatFrame(seen, agentId, conversationId));
    },
    seen_unmark: ({ agent_id: agentId, conversation_id: conversationId }, ctx) => {
      const moved = seen?.unmark(agentId, conversationId);
      ctx.track("conversation_kept_unread");
      if (moved && seen) ctx.broadcast(seenChatFrame(seen, agentId, conversationId));
    },
    // Not tracked: a look happens on every open, it is not a decision.
    viewed_mark: ({ agent_id: agentId, conversation_id: conversationId }, ctx) => {
      const looked = seen?.view(agentId, conversationId);
      const engaged = seen?.engage(agentId, conversationId, "open"); // opening and reading is engagement too
      if (seen && (looked || engaged)) ctx.broadcast(seenChatFrame(seen, agentId, conversationId));
    },
    // Messages are counted at turn_start (every surface, the terminal too); opens at viewed_mark. What is left: answers and decisions.
    focus_add: ({ agent_id: agentId, conversation_id: conversationId, action }, ctx) => {
      if (seen?.engage(agentId, conversationId, action)) ctx.broadcast(seenChatFrame(seen, agentId, conversationId));
    },
    // Tracked as part of the decision (inbox_card_decided), which says the rung.
    card_rest: ({ agent_id: agentId, conversation_id: conversationId, rest }, ctx) => {
      if (seen?.rest(agentId, conversationId, rest)) ctx.broadcast(seenChatFrame(seen, agentId, conversationId));
    },
  };
}
