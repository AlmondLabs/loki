import type { MacIdentity, PeerSummary } from "../../core/frame-types.ts";
import type { Pushes, Replies } from "../../core/frames.ts";
import { fail, reply, type FrameHandlers } from "./context.ts";

/** What Settings › Macs' frame handler needs from its host; without `peers` every frame fails with an error. */
export interface PeersDeps {
  /** Pairing between Macs (mod/peers.ts), as the mod wires it to the listener. */
  peers?: {
    /** This Mac and the Macs paired with it, as the `peers` push carries them. */
    view: () => Pushes["peers"];
    /** Mint a code another Mac types; brings the listener up while the code lives. */
    begin: () => Pushes["peer_pair_code"];
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
    peers_get: (_, ctx) => ctx.push({ type: "peers", ...need().view() }),
    peer_pair_begin: (_, ctx) => ctx.push({ type: "peer_pair_code", ...need().begin() }),
    peer_pair_join: async ({ host, code }, ctx) => {
      const p = need();
      try {
        const peer = await p.join(host, code);
        ctx.broadcast({ type: "peers", ...p.view() });
        return reply({ peer });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
    peer_forget: async ({ mac_id: macId }, ctx) => {
      const p = need();
      await p.forget(macId);
      ctx.broadcast({ type: "peers", ...p.view() });
    },
  };
}
