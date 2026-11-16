import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { isAgentId } from "../core/frames.ts";
import type { MemoryApplied, MemoryRepos } from "../daemon/memory-sync.ts";
import type { PeerLink } from "./peer-link.ts";
import { log } from "./log.ts";
import { memoryRoot } from "./agents.ts";

export class PeerMemory {
  private readonly opts: {
    backendDir: () => string;
    repos: MemoryRepos;
    macId: string;
    link: (macId: string) => PeerLink | null;
    homeOf: (agentId: string) => string;
    tell: (agentId: string) => void;
    onCloned: (agentId: string) => void;
  };
  private readonly told = new Map<string, string>();
  private stopWatching: (() => void) | null = null;

  constructor(opts: PeerMemory["opts"]) {
    this.opts = opts;
  }

  private root(agentId: string): string {
    return memoryRoot(agentId, this.opts.backendDir());
  }

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

  bundle(agentId: string, have: string[]): Promise<string | null> {
    return this.opts.repos.bundle(this.root(agentId), have);
  }

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

  async pullAll(macId: string): Promise<void> {
    for (const agentId of knownAgents(this.opts.backendDir())) await this.pull(macId, agentId);
  }
}

function knownAgents(backendDir: string): string[] {
  const ids = new Set<string>();
  try {
    for (const name of readdirSync(join(backendDir, "memfs"))) if (isAgentId(name)) ids.add(name);
  } catch {}
  try {
    for (const file of readdirSync(join(backendDir, "agents"))) {
      if (!file.endsWith(".json")) continue;
      try {
        const id = (JSON.parse(readFileSync(join(backendDir, "agents", file), "utf8")) as { id?: unknown }).id;
        if (isAgentId(id)) ids.add(id);
      } catch {}
    }
  } catch {}
  return [...ids];
}
