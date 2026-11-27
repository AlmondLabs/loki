import { SHARED_SCOPE, type Scope } from "../../core/chat-scope.ts";
import type { Pushes } from "../../core/frames.ts";
import type { ChatMeta, ChatStatus, ChatSummary } from "../../core/frame-types.ts";
import type { FrameHandlers } from "./context.ts";

export interface ChatsDeps {
  listChats?: () => ChatSummary[];
  chatMeta?: (scope: Scope) => ChatMeta;
  setPin?: (agentId: string, conversationId: string, pinned: boolean) => boolean;
  recentModels?: { read: () => string[]; add: (handle: string) => string[] };
}

export function chatMetaFrame(deps: ChatsDeps, scope: Scope): { type: "chat_meta" } & Pushes["chat_meta"] {
  const info = deps.chatMeta?.(scope) ?? { title: null, status: "none" as ChatStatus, agent_name: null, agent_id: null, model: null, reasoning_effort: null };
  return {
    type: "chat_meta",
    scope,
    title: info.title,
    status: info.status,
    agent_name: info.agent_name,
    agent_id: info.agent_id,
    model: info.model,
    reasoning_effort: info.reasoning_effort,
    mode: info.mode ?? null,
  };
}

export function chatsFrames(deps: ChatsDeps): FrameHandlers {
  const chats = (): { type: "chats" } & Pushes["chats"] => ({ type: "chats", chats: deps.listChats?.() ?? [] });
  return {
    chats_list: (_, ctx) => ctx.push(chats()),
    pin_set: ({ agent_id: agentId, conversation_id: conversationId, pinned }, ctx) => {
      if (!deps.setPin) return;
      deps.setPin(agentId, conversationId, pinned);
      ctx.broadcast(chats());
    },
    models_recent_add: ({ handle }, ctx) => {
      if (!deps.recentModels) return;
      ctx.broadcast({ type: "models_recent", recent: deps.recentModels.add(handle) });
    },
  };
}

const STATUS_RANK: Record<ChatStatus, number> = { live: 0, none: 0, archived: 1, deleted: 2 };

export function sortChats(desks: ChatSummary[]): ChatSummary[] {
  return [...desks].sort((a, b) => {
    if (b.scope === a.scope) return 0;
    if (a.scope === SHARED_SCOPE) return -1;
    if (b.scope === SHARED_SCOPE) return 1;
    if (STATUS_RANK[a.status] !== STATUS_RANK[b.status]) return STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    if (a.active !== b.active) return a.active ? -1 : 1;
    return (b.last_active ?? "").localeCompare(a.last_active ?? "") || (a.title ?? a.scope).localeCompare(b.title ?? b.scope);
  });
}
