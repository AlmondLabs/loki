import type { Pushes } from "../../core/frames.ts";
import type { SeenStore } from "../seen.ts";
import type { FrameHandlers } from "./context.ts";

export interface SeenDeps {
  seen?: SeenStore;
}

export function seenFrame(deps: SeenDeps): { type: "seen" } & Pushes["seen"] {
  const { seen } = deps;
  return {
    type: "seen",
    seen: seen?.all() ?? {},
    viewed: seen?.viewedAll() ?? {},
    focus: seen?.focusAll() ?? {},
    rests: seen?.restsAll() ?? {},
    return_times: seen?.returnTimes() ?? null,
    lanes: seen?.lanes() ?? [],
  };
}

export function seenChatFrame(seen: SeenStore, agentId: string | null, conversationId: string): { type: "seen_chat" } & Pushes["seen_chat"] {
  return { type: "seen_chat", ...seen.chat(agentId, conversationId) };
}

export function seenFrames(deps: SeenDeps): FrameHandlers {
  const { seen } = deps;
  return {
    seen_list: (_, ctx) => ctx.push(seenFrame(deps)),
    seen_mark: ({ agent_id: agentId, conversation_id: conversationId }, ctx) => {
      const moved = seen?.mark(agentId, conversationId);
      if (moved && seen) ctx.broadcast(seenChatFrame(seen, agentId, conversationId));
    },
    seen_unmark: ({ agent_id: agentId, conversation_id: conversationId }, ctx) => {
      const moved = seen?.unmark(agentId, conversationId);
      if (moved && seen) ctx.broadcast(seenChatFrame(seen, agentId, conversationId));
    },
    viewed_mark: ({ agent_id: agentId, conversation_id: conversationId }, ctx) => {
      const looked = seen?.view(agentId, conversationId);
      const engaged = seen?.engage(agentId, conversationId, "open");
      if (seen && (looked || engaged)) ctx.broadcast(seenChatFrame(seen, agentId, conversationId));
    },
    focus_add: ({ agent_id: agentId, conversation_id: conversationId, action }, ctx) => {
      if (seen?.engage(agentId, conversationId, action)) ctx.broadcast(seenChatFrame(seen, agentId, conversationId));
    },
    card_rest: ({ agent_id: agentId, conversation_id: conversationId, rest }, ctx) => {
      if (seen?.rest(agentId, conversationId, rest)) ctx.broadcast(seenChatFrame(seen, agentId, conversationId));
    },
    return_times_set: ({ return_times: times }, ctx) => {
      if (seen?.setReturnTimes(times)) ctx.broadcast(seenFrame(deps));
    },
    lanes_set: ({ lanes }, ctx) => {
      if (seen?.setLanes(lanes)) ctx.broadcast(seenFrame(deps));
    },
  };
}
