import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { isAgentId } from "../core/frames.ts";
import type { MemoryApplied, MemoryRepos } from "../daemon/memory-sync.ts";
import type { PeerLink } from "./peer-link.ts";
import { log } from "./log.ts";

/**
 * Every agent's memory the same on every paired Mac (plan 023, U7, R18). When a repo here gets new commits, paired
 * Macs are told (`memory_changed`) and ask for what they lack; when a paired Mac says the same, this Mac asks it. A
 * Mac's link opening, or an agent arriving from it, asks for all of it. Merges go through daemon/memory-sync.ts, taken
 * from the host (`repos`) so they share the daemon's queue (plan 046).
 */
export class PeerMemory {
  private readonly opts: {
    backendDir: () => string;
    /** The daemon's memory repos (Host.memory): its queue, so this hears every commit and merges never race one. */
    repos: MemoryRepos;
    macId: string;
    link: (macId: string) => PeerLink | null;
    /** The Mac an agent lives on (its record's home_mac, else this Mac). */
    homeOf: (agentId: string) => string;
    /** Tell paired Macs an agent's memory has new commits here. */
    tell: (agentId: string) => void;
    /** An agent's memory arrived here for the first time: it can be listed now. */
    onCloned: (agentId: string) => void;
  };
  /** The commit each agent's memory was at when paired Macs were last told. */
  private readonly told = new Map<string, string>();
  private stopWatching: (() => void) | null = null;

  constructor(opts: PeerMemory["opts"]) {
    this.opts = opts;
  }

  private root(agentId: string): string {
    return join(this.opts.backendDir(), "memfs", agentId, "memory");
  }

  /** Watch this Mac's memory repos, telling paired Macs when one moves. */
  start(): void {
    this.stopWatching?.();
    const memfs = join(this.opts.backendDir(), "memfs") + sep;
    this.stopWatching = this.opts.repos.onSettled((root) => {
      if (!root.startsWith(memfs)) return;
      const agentId = root.slice(memfs.length).split(sep)[0];
      if (isAgentId(agentId)) void this.check(agentId);
    });
  }

  stop(): void {
    this.stopWatching?.();
    this.stopWatching = null;
  }

  private async check(agentId: string): Promise<void> {
    const head = await this.opts.repos.head(this.root(agentId));
    if (!head || this.told.get(agentId) === head) return;
    this.told.set(agentId, head);
    this.opts.tell(agentId);
  }

  /** What another Mac lacks of an agent's memory, given the commits it has. */
  bundle(agentId: string, have: string[]): Promise<string | null> {
    return this.opts.repos.bundle(this.root(agentId), have);
  }

  /** Ask a Mac for an agent's memory commits this Mac lacks, and take them. */
  async pull(macId: string, agentId: string): Promise<MemoryApplied> {
    const link = this.opts.link(macId);
    if (!link || !isAgentId(agentId)) return "unchanged";
    const root = this.root(agentId);
    const head = await this.opts.repos.head(root);
    let reply: Record<string, unknown>;
    try {
      reply = await link.request({ type: "peer_memory_get", agent_id: agentId, have: head ? [head] : [] }, 60_000);
    } catch {
      return "unchanged";
    }
    if (typeof reply.bundle !== "string") return "unchanged";
    const applied = await this.opts.repos.apply(root, reply.bundle, { from: macId, homeIsHere: this.opts.homeOf(agentId) === this.opts.macId });
    if (applied !== "unchanged") log("peers:memory", { from: macId, agent: agentId, applied });
    if (applied === "cloned") this.opts.onCloned(agentId);
    return applied;
  }

  /** Ask a Mac for every agent's memory this Mac knows of, the ones with only a record (just arrived) among them. */
  async pullAll(macId: string): Promise<void> {
    for (const agentId of knownAgents(this.opts.backendDir())) await this.pull(macId, agentId);
  }
}

/** Every agent this Mac has a record or a memory folder for. */
function knownAgents(backendDir: string): string[] {
  const ids = new Set<string>();
  try {
    for (const name of readdirSync(join(backendDir, "memfs"))) if (isAgentId(name)) ids.add(name);
  } catch {
    // no memory yet
  }
  try {
    for (const file of readdirSync(join(backendDir, "agents"))) {
      if (!file.endsWith(".json")) continue;
      try {
        const id = (JSON.parse(readFileSync(join(backendDir, "agents", file), "utf8")) as { id?: unknown }).id;
        if (isAgentId(id)) ids.add(id);
      } catch {
        // an unreadable record
      }
    }
  } catch {
    // no records yet
  }
  return [...ids];
}
