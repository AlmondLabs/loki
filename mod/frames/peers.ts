import type { MacIdentity, PeerSummary } from "../../core/frame-types.ts";
import type { Pushes, Replies, StateFolder } from "../../core/frames.ts";
import { fail, reply, type FrameHandlers } from "./context.ts";
import { messageOf } from "../../core/errors.ts";

export interface PeerMoves {
  candidates: (macId: string) => Promise<Replies["peer_moves"]["chats"]>;
  export: (macId: string, agentId: string, conversationId: string) => Promise<Replies["peer_chat"]>;
  moved: (macId: string, agentId: string, conversationId: string) => Promise<void>;
  take: (macId: string, agentId: string, conversationId: string) => Promise<Replies["peer_chat_taken"]>;
  offer: (to: string, agentId: string, conversationId: string) => Promise<string | null>;
  keepHere: (agentId: string, conversationId: string) => string | null;
}
export interface PeersDeps {
  peers?: {
    view: () => Pushes["peers"];
    begin: () => Promise<Pushes["peer_pair_code"]>;
    refresh?: () => Promise<unknown>;
    join: (host: string, code: string) => Promise<PeerSummary>;
    forget: (macId: string) => Promise<boolean>;
    hello: () => MacIdentity & { build: string | null; protocol: number };
    agents: () => Replies["peer_agents"];
    chats: () => Replies["peer_chats"];
    moves?: PeerMoves;
    group?: {
      macs: () => Replies["peer_group"]["macs"];
      introduce: (from: string, macId: string) => Promise<Replies["peer_invite"]>;
      invite: (macId: string) => Replies["peer_invite"] | null;
    };
    where?: (chat: { agent_id: string | null; conversation_id: string }) => Replies["peer_here"];
    state: (folders?: StateFolder[]) => Replies["peer_state"];
    memory: (agentId: string, have: string[]) => Promise<Replies["peer_memory"]>;
  };
}

export function peersFrames({ peers }: PeersDeps): FrameHandlers {
  const need = () => {
    if (!peers) throw new Error("pairing Macs is not available in this mod");
    return peers;
  };
  return {
    peer_ping: () => {
      const { mac_id: macId, name, build, protocol } = need().hello();
      return reply({ mac_id: macId, name, build, protocol });
    },
    peer_agents_get: () => reply(need().agents()),
    peer_chats_get: () => reply(need().chats()),
    peer_state_get: ({ folders }) => reply(need().state(folders)),
    peer_moves_get: async (_, ctx) => {
      const moves = need().moves;
      return reply({ chats: moves && ctx.client.peerId ? await moves.candidates(ctx.client.peerId) : [] });
    },
    peer_chat_export: async ({ agent_id: agentId, conversation_id: conversationId }, ctx) => {
      const moves = need().moves;
      if (!moves || !ctx.client.peerId) return fail("only another Mac takes a chat over");
      return reply(await moves.export(ctx.client.peerId, agentId, conversationId));
    },
    peer_chat_moved: async ({ agent_id: agentId, conversation_id: conversationId }, ctx) => {
      const moves = need().moves;
      if (!moves || !ctx.client.peerId) return fail("only another Mac takes a chat over");
      await moves.moved(ctx.client.peerId, agentId, conversationId);
      return reply({});
    },
    peer_chat_take: async ({ agent_id: agentId, conversation_id: conversationId }, ctx) => {
      const moves = need().moves;
      if (!moves || !ctx.client.peerId) return fail("only another Mac offers a chat");
      return reply(await moves.take(ctx.client.peerId, agentId, conversationId));
    },
    chat_move_keep: ({ agent_id: agentId, conversation_id: conversationId }) => {
      const moves = need().moves;
      if (!moves) return fail("moving chats between Macs is not available in this mod");
      const why = moves.keepHere(agentId, conversationId);
      return why ? fail(why) : reply({});
    },
    chat_move: async ({ agent_id: agentId, conversation_id: conversationId, to }) => {
      const moves = need().moves;
      if (!moves) return fail("moving chats between Macs is not available in this mod");
      const why = await moves.offer(to, agentId, conversationId);
      return why ? fail(why) : reply({});
    },
    peer_group_get: () => {
      const group = need().group;
      return group ? reply({ macs: group.macs() }) : fail("this Mac does not introduce Macs");
    },
    peer_introduce: async ({ mac_id: macId }, ctx) => {
      const group = need().group;
      if (!group || !ctx.client.peerId) return fail("only a paired Mac is introduced");
      try {
        return reply(await group.introduce(ctx.client.peerId, macId));
      } catch (err) {
        return fail(messageOf(err));
      }
    },
    peer_invite_get: ({ for: macId }, ctx) => {
      const group = need().group;
      if (!group || !ctx.client.peerId) return fail("only a paired Mac asks for an invite");
      const invite = group.invite(macId);
      return invite ? reply(invite) : fail("this Mac does not pair with that one");
    },
    peer_where: (chat) => {
      const where = need().where;
      return where ? reply(where(chat)) : fail("this Mac does not keep a chat directory");
    },
    peer_memory_get: async ({ agent_id: agentId, have }) => reply(await need().memory(agentId, have)),
    peers_get: async (_, ctx) => {
      const p = need();
      await p.refresh?.();
      ctx.push({ type: "peers", ...p.view() });
    },
    peer_pair_begin: async (_, ctx) => ctx.push({ type: "peer_pair_code", ...(await need().begin()) }),
    peer_pair_join: async ({ host, code }, ctx) => {
      const p = need();
      try {
        const peer = await p.join(host, code);
        ctx.broadcast({ type: "peers", ...p.view() });
        return reply({ peer });
      } catch (err) {
        return fail(messageOf(err));
      }
    },
    peer_forget: async ({ mac_id: macId }, ctx) => {
      const p = need();
      await p.forget(macId);
      ctx.broadcast({ type: "peers", ...p.view() });
    },
  };
}
