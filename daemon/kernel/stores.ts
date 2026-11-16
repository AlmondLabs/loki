import type { Context } from "@earendil-works/chord";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CURRENT_SQLITE_SCHEMA_VERSION } from "@earendil-works/pi-durable/storage/sqlite";
import { AgentStore, type StoreOptions } from "./index.ts";
import { backupBeforeMigration } from "../store-backup.ts";
import { STORE_VERSION, acpConversations, markStoreVersion, migrateStoredEntries, storeVersion } from "../store-migration.ts";
import { Listeners } from "../../core/listeners.ts";

export class StoreManager {
  private readonly open = new Map<string, Promise<AgentStore>>();
  private readonly closing = new Set<string>();
  private readonly listeners = new Listeners<[agentId: string, store: AgentStore]>();

  private readonly dir: string;
  private readonly context: Context;
  private readonly report: (message: string) => void;
  private readonly openStore: (file: string) => Promise<AgentStore>;

  constructor(
    dir: string,
    options: StoreOptions,
    context: Context,
    report: (message: string) => void = () => {},
    openStore?: (file: string) => Promise<AgentStore>,
  ) {
    this.dir = dir;
    this.context = context;
    this.report = report;
    this.openStore =
      openStore ??
      (async (file) => {
        mkdirSync(dir, { recursive: true });
        // A newer pi-durable migrates the store as it opens it, for good: copy it first (plan 039). A copy that fails
        const copy = backupBeforeMigration(file, CURRENT_SQLITE_SCHEMA_VERSION);
        if (copy) report(`store ${file} copied to ${copy} before pi-durable migrates it`);
        const behind = storeVersion(file) < STORE_VERSION;
        const store = await AgentStore.open({ file }, options, context);
        if (behind) {
          const migrated = migrateStoredEntries(
            file,
            await acpConversations(store, context),
            join(dir, `backup-letta-${new Date().toISOString().slice(0, 10)}`),
          );
          if (migrated.backup) report(`store ${file}: ${migrated.entries} saved entries rewritten as loki writes them now, copied first to ${migrated.backup}`);
          markStoreVersion(file);
        }
        return store;
      });
  }

  file(agentId: string): string {
    return join(this.dir, `${agentId}.sqlite`);
  }

  get(agentId: string): Promise<AgentStore> {
    const known = this.open.get(agentId);
    if (known) return known;
    const opening = this.openStore(this.file(agentId)).then((store) => {
      store.harness.subscribeClose(() => this.closed(agentId, store));
      store.harness.resume();
      this.listeners.emit(agentId, store);
      return store;
    });
    opening.catch((error: unknown) => {
      this.open.delete(agentId);
      this.report(`store of ${agentId} did not open: ${String(error)}`);
    });
    this.open.set(agentId, opening);
    return opening;
  }

  agents(): string[] {
    return [...this.open.keys()];
  }

  onOpen(listener: (agentId: string, store: AgentStore) => void): () => void {
    return this.listeners.add(listener);
  }

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
