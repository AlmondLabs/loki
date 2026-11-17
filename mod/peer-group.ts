import type { PeerLink } from "./peer-link.ts";
import { log } from "./log.ts";
import { messageOf } from "../core/errors.ts";

export interface GroupMac {
  mac_id: string;
  name: string;
  host: string;
}

export interface PeerGroupOptions {
  here: string;
  paired: (macId: string) => boolean;
  forgotten: (macId: string) => boolean;
  link: (macId: string) => PeerLink | null;
  join: (host: string, invite: string) => Promise<unknown>;
}

export class PeerGroup {
  private readonly opts: PeerGroupOptions;
  private readonly running = new Set<string>();

  constructor(opts: PeerGroupOptions) {
    this.opts = opts;
  }

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

  async introduce(from: string, macId: string): Promise<{ host: string; code: string }> {
    if (!this.opts.paired(from) || !this.opts.paired(macId) || from === macId) throw new Error("not a Mac this one can introduce");
    const link = this.opts.link(macId);
    if (!link) throw new Error("that Mac is out of reach");
    const invite = (await link.request({ type: "peer_invite_get", for: from })) as { host?: unknown; code?: unknown };
    if (typeof invite.host !== "string" || typeof invite.code !== "string") throw new Error("that Mac gave no invite");
    return { host: invite.host, code: invite.code };
  }
}
