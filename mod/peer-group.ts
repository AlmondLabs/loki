import type { PeerLink } from "./peer-link.ts";
import { log } from "./log.ts";
import { messageOf } from "../core/errors.ts";

/**
 * Every paired Mac paired with every other (plan 023, addendum D), since a chat's frames go one hop to its home. When a
 * link to a paired Mac opens, or its paired Macs change, this Mac asks it which Macs it is paired with and joins any it
 * does not know: that Mac introduces it, the third Mac mints an invite for it alone, and it pairs with the third Mac
 * directly. Of two Macs that could join each other, the lower id joins, so two pairings never cross. A Mac forgotten
 * here on purpose is not joined.
 */

/** A Mac in another Mac's group, as it is asked for: who, and where to reach it on the tailnet. */
export interface GroupMac {
  mac_id: string;
  name: string;
  host: string;
}

/** What the group is built from: this Mac, its paired Macs, the links to them, and pairing with an invite. */
export interface PeerGroupOptions {
  here: string;
  paired: (macId: string) => boolean;
  forgotten: (macId: string) => boolean;
  link: (macId: string) => PeerLink | null;
  /** Pair with the Mac at `host` by an invite (Peers.join). */
  join: (host: string, invite: string) => Promise<unknown>;
}

/** The group's own work: joining through a paired Mac, and the introduction a paired Mac asks of this one. */
export class PeerGroup {
  private readonly opts: PeerGroupOptions;
  private readonly running = new Set<string>();

  constructor(opts: PeerGroupOptions) {
    this.opts = opts;
  }

  /** Join the Macs `via` is paired with that this Mac is not, as this Mac is the one to join (the lower id). */
  async meshWith(via: string): Promise<string[]> {
    const link = this.opts.link(via);
    if (!link || this.running.has(via)) return [];
    this.running.add(via);
    const joined: string[] = [];
    try {
      const { macs } = (await link.request({ type: "peer_group_get" })) as { macs?: GroupMac[] };
      for (const m of macs ?? []) {
        if (m.mac_id === this.opts.here || this.opts.paired(m.mac_id) || this.opts.forgotten(m.mac_id) || this.opts.here > m.mac_id) continue;
        try {
          const invite = (await link.request({ type: "peer_introduce", mac_id: m.mac_id })) as { host?: unknown; code?: unknown };
          if (typeof invite.host !== "string" || typeof invite.code !== "string") continue;
          await this.opts.join(invite.host, invite.code);
          joined.push(m.mac_id);
          log("peers:joined-group", { via, mac: m.mac_id });
        } catch (err) {
          // That Mac out of reach, or it forgot this one: it is tried again at the next contact.
          log("peers:join-failed", { via, mac: m.mac_id, error: messageOf(err) });
        }
      }
    } catch (err) {
      log("peers:group-failed", { via, error: messageOf(err) });
    } finally {
      this.running.delete(via);
    }
    return joined;
  }

  /**
   * A paired Mac (`from`) asks to be introduced to `macId`, another Mac paired with this one: that Mac's invite for it,
   * or why not. Only between Macs this one is paired with.
   */
  async introduce(from: string, macId: string): Promise<{ host: string; code: string }> {
    if (!this.opts.paired(from) || !this.opts.paired(macId) || from === macId) throw new Error("not a Mac this one can introduce");
    const link = this.opts.link(macId);
    if (!link) throw new Error("that Mac is out of reach");
    const invite = (await link.request({ type: "peer_invite_get", for: from })) as { host?: unknown; code?: unknown };
    if (typeof invite.host !== "string" || typeof invite.code !== "string") throw new Error("that Mac gave no invite");
    return { host: invite.host, code: invite.code };
  }
}
