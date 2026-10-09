import type { Context } from "@earendil-works/chord";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AgentStore, type StoreOptions } from "./index.ts";

/**
 * Every agent's store (plan 017, KTD2, KTD18): one pi-durable Harness over one SQLite file per agent, opened on first
 * use and shared after. A storage error closes a Harness and every later call on it fails; the manager notices the
 * close it did not ask for and opens the store again, so that agent's chats come back while the others never stopped.
 */
export class StoreManager {
  private readonly open = new Map<string, Promise<AgentStore>>();
  private readonly closing = new Set<string>();
  private readonly listeners = new Set<(agentId: string, store: AgentStore) => void>();

  private readonly dir: string;
  private readonly context: Context;
  private readonly report: (message: string) => void;
  private readonly openStore: (file: string) => Promise<AgentStore>;

  /** `openStore` opens one store; tests open them on memory. */
  constructor(dir: string, options: StoreOptions, context: Context, report: (message: string) => void = () => {}, openStore?: (file: string) => Promise<AgentStore>) {
    this.dir = dir;
    this.context = context;
    this.report = report;
    this.openStore =
      openStore ??
      ((file) => {
        mkdirSync(dir, { recursive: true });
        return AgentStore.open({ file }, options, context);
      });
  }

  /** Where an agent's store lives. */
  file(agentId: string): string {
    return join(this.dir, `${agentId}.sqlite`);
  }

  /** The agent's store, opened if it is not yet. */
  get(agentId: string): Promise<AgentStore> {
    const known = this.open.get(agentId);
    if (known) return known;
    const opening = this.openStore(this.file(agentId)).then((store) => {
      store.harness.subscribeClose(() => this.closed(agentId, store));
      store.harness.resume();
      for (const listener of this.listeners) listener(agentId, store);
      return store;
    });
    // A store that fails to open is forgotten, so the next call tries again.
    opening.catch((error) => {
      this.open.delete(agentId);
      this.report(`store of ${agentId} did not open: ${String(error)}`);
    });
    this.open.set(agentId, opening);
    return opening;
  }

  /** The agents whose stores are open now. */
  agents(): string[] {
    return [...this.open.keys()];
  }

  /** Called with each store as it opens, and again when it reopens after a failure. */
  onOpen(listener: (agentId: string, store: AgentStore) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Close one agent's store, as when the agent is deleted. */
  async close(agentId: string): Promise<void> {
    const opening = this.open.get(agentId);
    if (!opening) return;
    this.closing.add(agentId);
    this.open.delete(agentId);
    try {
      await (await opening).close(this.context);
    } finally {
      this.closing.delete(agentId);
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.agents().map((id) => this.close(id)));
  }

  /** A store closed: by us, nothing to do; on its own (a storage error), open it again once the old one is gone. */
  private closed(agentId: string, store: AgentStore): void {
    if (this.closing.has(agentId)) return;
    void this.open.get(agentId)?.then((current) => {
      if (current !== store) return;
      this.report(`store of ${agentId} closed on its own; opening it again`);
      this.open.delete(agentId);
      void this.get(agentId);
    });
  }
}
