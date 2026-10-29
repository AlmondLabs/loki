import { applyShared, readTombstones, sharedAgents, type AppliedAgents, type SharedAgent, type Tombstone } from "../daemon/store/agent-sync.ts";
import { isAgentId } from "../core/frames.ts";
import type { PeerLink } from "./peer-link.ts";
import { log } from "./log.ts";
import { serialQueue } from "../core/serial.ts";

/**
 * The person's agents kept the same on every paired Mac (plan 023, U3). This Mac answers another's `peer_agents_get`
 * with its records and tombstones, and pulls the same from a Mac when its link opens or it says its agents changed
 * (`agents_changed`). Pulls run one at a time, so two Macs' answers never write a record at once.
 */
export class PeerAgents {
  private readonly opts: {
    backendDir: () => string;
    macId: string;
    link: (macId: string) => PeerLink | null;
    /** Remove an agent here because another Mac deleted it. */
    remove: (agentId: string) => Promise<void>;
    /** Records or deletes arrived: tell every window, and every paired Mac. */
    onChanged: (applied: AppliedAgents) => void;
  };
  /** Pulls run one at a time, one Mac after another. */
  private readonly serial = serialQueue();

  constructor(opts: PeerAgents["opts"]) {
    this.opts = opts;
  }

  /** What this Mac sends another: its agents and the agents deleted here. */
  snapshot(): { agents: SharedAgent[]; tombstones: Tombstone[] } {
    return { agents: sharedAgents(this.opts.backendDir(), this.opts.macId), tombstones: readTombstones(this.opts.backendDir()) };
  }

  /** Ask a Mac for its agents and take them; resolves with what changed here (nothing when it is out of reach). */
  pull(macId: string): Promise<AppliedAgents> {
    const none: AppliedAgents = { created: [], updated: [], deleted: [] };
    return this.serial(async () => {
      const link = this.opts.link(macId);
      if (!link) return none;
      let reply: Record<string, unknown>;
      try {
        reply = await link.request({ type: "peer_agents_get" });
      } catch {
        return none;
      }
      const applied = await applyShared(this.opts.backendDir(), parseSnapshot(reply), (id) => this.opts.remove(id));
      if (applied.created.length || applied.updated.length || applied.deleted.length) {
        log("peers:agents", { from: macId, ...applied });
        this.opts.onChanged(applied);
      }
      return applied;
    });
  }
}

/** Another Mac's `peer_agents` reply, with anything malformed left out. */
export function parseSnapshot(reply: Record<string, unknown>): { agents: SharedAgent[]; tombstones: Tombstone[] } {
  const agents = Array.isArray(reply.agents)
    ? reply.agents.flatMap((a: unknown) => {
        const x = a as { id?: unknown; record?: unknown };
        return typeof a === "object" && a !== null && isAgentId(x.id) && typeof x.record === "object" && x.record !== null
          ? [{ id: x.id, record: x.record as Record<string, unknown> }]
          : [];
      })
    : [];
  const tombstones = Array.isArray(reply.tombstones)
    ? reply.tombstones.filter(
        (t: unknown): t is Tombstone =>
          typeof t === "object" &&
          t !== null &&
          isAgentId((t as Tombstone).id) &&
          typeof (t as Tombstone).at === "string" &&
          typeof (t as Tombstone).mac === "string",
      )
    : [];
  return { agents, tombstones };
}
