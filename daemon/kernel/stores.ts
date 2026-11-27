import type { Context } from "@earendil-works/chord/context";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CURRENT_SQLITE_SCHEMA_VERSION } from "@earendil-works/pi-durable/storage/sqlite";
import { AgentStore, type StoreOptions } from "./index.ts";
import { backupBeforeMigration } from "../store-backup.ts";
import { Listeners } from "../../core/listeners.ts";
import type { Report } from "../report.ts";

export class StoreManager {
  private readonly open = new Map<string, Promise<AgentStore>>();
  private readonly closing = new Set<string>();
  private readonly listeners = new Listeners<[agentId: string, store: AgentStore]>();

  private readonly dir: string;
  private readonly context: Context;
  private readonly report: Report;
  private readonly openStore: (file: string) => Promise<AgentStore>;

  constructor(dir: string, options: StoreOptions, context: Context, report: Report = () => {}, openStore?: (file: string) => Promise<AgentStore>) {
    this.dir = dir;
    this.context = context;
    this.report = report;
    this.openStore =
      openStore ??
      (async (file) => {
        mkdirSync(dir, { recursive: true });
        // Outside (pi-durable): a newer version migrates the store as it opens it, for good, so it is copied first. A copy
        // that fails stops the store from opening, reported, rather than leaving it with no way back.
        const copy = backupBeforeMigration(file, CURRENT_SQLITE_SCHEMA_VERSION);
        if (copy) report(`store ${file} copied to ${copy} before pi-durable migrates it`, "info");
        return AgentStore.open({ file }, options, context);
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
      this.report(`store of ${agentId} closed on its own; opening it again`, "warning");
      this.open.delete(agentId);
      void this.get(agentId);
    });
  }
}
