import { applyShared, readTombstones, sharedAgents, type AppliedAgents, type SharedAgent, type Tombstone } from "../daemon/store/agent-sync.ts";
import { isAgentId } from "../core/frames.ts";
import type { PeerLink } from "./peer-link.ts";
import { log } from "./log.ts";
import { serialQueue } from "../core/serial.ts";

export class PeerAgents {
  private readonly opts: {
    backendDir: () => string;
    macId: string;
    link: (macId: string) => PeerLink | null;
    remove: (agentId: string) => Promise<void>;
    onChanged: (applied: AppliedAgents) => void;
  };
  private readonly serial = serialQueue();

  constructor(opts: PeerAgents["opts"]) {
    this.opts = opts;
  }

  snapshot(): { agents: SharedAgent[]; tombstones: Tombstone[] } {
    return { agents: sharedAgents(this.opts.backendDir(), this.opts.macId), tombstones: readTombstones(this.opts.backendDir()) };
  }

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
