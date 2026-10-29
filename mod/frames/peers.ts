import type { MacIdentity, PeerSummary } from "../../core/frame-types.ts";
import type { Pushes, Replies, StateFolder } from "../../core/frames.ts";
import { fail, reply, type FrameHandlers } from "./context.ts";
import { messageOf } from "../../core/errors.ts";

/** The frames' side of moving chats between Macs: what another Mac asks of this one, and the person's own move. */
export interface PeerMoves {
  /** The chats here whose agent lives on `macId`, for it to take over. */
  candidates: (macId: string) => Promise<Replies["peer_moves"]["chats"]>;
  /** A chat here copied out for `macId`, which takes it over; `busy` while it must wait. */
  export: (macId: string, agentId: string, conversationId: string) => Promise<Replies["peer_chat"]>;
  /** `macId` holds the chat now: let it go here, and tell the paired Macs where it went. */
  moved: (macId: string, agentId: string, conversationId: string) => Promise<void>;
  /** Take one chat over from the Mac it lives on, because the person moved it here (addendum A1). */
  take: (macId: string, agentId: string, conversationId: string) => Promise<Replies["peer_chat_taken"]>;
  /** Offer one chat here to the paired Mac `to`: null once it moved, else why not, for the person. */
  offer: (to: string, agentId: string, conversationId: string) => Promise<string | null>;
}
/** What Settings › Macs' frame handler needs from its host; without `peers` every frame fails with an error. */
export interface PeersDeps {
  /** Pairing between Macs (mod/peers.ts), as the mod wires it to the listener. */
  peers?: {
    /** This Mac and the Macs paired with it, as the `peers` push carries them. */
    view: () => Pushes["peers"];
    /** Mint a code another Mac types; brings the listener up while the code lives, and asks Tailscale for the address. */
    begin: () => Promise<Pushes["peer_pair_code"]>;
    /** Ask Tailscale again, so this Mac's address is current rather than unknown (it is asked only when the listener starts). */
    refresh?: () => Promise<unknown>;
    /** Pair with the Mac at `host` using its code; throws a message for the person. */
    join: (host: string, code: string) => Promise<PeerSummary>;
    /** Forget a Mac, telling it when it can be reached. */
    forget: (macId: string) => Promise<boolean>;
    /** Who this Mac is and its peer protocol, for another Mac's `peer_ping`. */
    hello: () => MacIdentity & { build: string | null; protocol: number };
    /** This Mac's agents and tombstones, for another Mac's `peer_agents_get` (U3). */
    agents: () => Replies["peer_agents"];
    /** This Mac's own chats, for another Mac's `peer_chats_get` (U4). */
    chats: () => Replies["peer_chats"];
    /** Moving chats between this Mac and the paired ones (U9, addendum A1): mod/chat-moves.ts. */
    moves?: PeerMoves;
    /** The group (addendum D): this Mac's paired Macs, introducing one to another, and an invite for one. */
    group?: {
      macs: () => Replies["peer_group"]["macs"];
      introduce: (from: string, macId: string) => Promise<Replies["peer_invite"]>;
      invite: (macId: string) => Replies["peer_invite"] | null;
    };
    /** Whether this Mac holds a chat, and where it went if this Mac let it go, for `peer_where` (addendum B2). */
    where?: (chat: { agent_id: string | null; conversation_id: string }) => Replies["peer_here"];
    /** The person's state, for another Mac's `peer_state_get` (U8): the folders it named, or all of them. */
    state: (folders?: StateFolder[]) => Replies["peer_state"];
    /** An agent's memory commits another Mac lacks, for its `peer_memory_get` (U7). */
    memory: (agentId: string, have: string[]) => Promise<Replies["peer_memory"]>;
  };
}

/**
 * Settings › Macs (plan 023, U1): this Mac, the Macs paired with it, a code to pair another, and pairing with one
 * from its code. Changes are broadcast so every window reads the same list.
 */
export function peersFrames({ peers }: PeersDeps): FrameHandlers {
  const need = () => {
    if (!peers) throw new Error("pairing Macs is not available in this mod");
    return peers;
  };
  return {
    // Another Mac's peer link opening (U2): who answers, and on which protocol.
    peer_ping: () => {
      const { mac_id: macId, name, build, protocol } = need().hello();
      return reply({ mac_id: macId, name, build, protocol });
    },
    peer_agents_get: () => reply(need().agents()),
    peer_chats_get: () => reply(need().chats()),
    peer_state_get: ({ folders }) => reply(need().state(folders)),
    // Only another Mac asks these, and it names itself by its socket (U9).
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
    // The chat lives here (a tab here, or the Mac it moves to, asked): this Mac offers it to `to` (addendum A1).
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
    // Asked by a Mac paired with this one, for a Mac it is introducing: never by a tab or a phone (PEER frames only).
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
