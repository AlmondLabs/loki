import type { Context, JsonValue } from "@earendil-works/chord";
import {
  defineDoc,
  Harness,
  type Conversation,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type HarnessOptions,
  type Storage,
} from "@earendil-works/pi-durable";
import type { ImportedEntry } from "../import/convert.ts";

/**
 * The daemon's only door to pi-durable (plan 017, KTD1). Each agent has one store, a Harness over one SQLite file
 * (KTD2), holding every chat of that agent. pi-durable numbers its conversations itself, so a session document maps
 * loki's chat ids (Letta's `local-conv-…`, `default`) to them, and a conversation document carries what loki keeps
 * about a chat (KTD6). When pi-durable's API changes, this module changes and nothing that imports it does.
 */

/** loki's chat id → pi-durable conversation id, for one agent's store. */
export const ChatIndex = defineDoc<{ chats: Record<string, number> }>({
  kind: "loki.chats",
  version: 1,
  scope: "session",
  initial: () => ({ chats: {} }),
});

/** What loki keeps about one chat, committed with the chat it describes. */
export type ChatInfo = { id: string; title: string | null; archived: boolean; createdAt: string };

export const ChatDoc = defineDoc<ChatInfo>({
  kind: "loki.chat",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ id: "", title: null, archived: false, createdAt: "" }),
});

export type StoreOptions = Pick<HarnessOptions, "models" | "registry" | "settings" | "env" | "onReport" | "now">;

/** One agent's chats on one pi-durable Harness. */
export class AgentStore {
  readonly harness: Harness;

  private constructor(harness: Harness) {
    this.harness = harness;
  }

  /**
   * Open a store over `storage`, or over the SQLite file at `file`. The SQLite backend is Node's own `node:sqlite`,
   * loaded only when a file is asked for, so tests on memory storage run under Bun.
   */
  static async open(where: { file: string } | { storage: Storage }, options: StoreOptions, context: Context): Promise<AgentStore> {
    const storage =
      "storage" in where ? where.storage : await (await import("@earendil-works/pi-durable/storage/sqlite/node")).openNodeSqliteStorage(where.file);
    return new AgentStore(await Harness.open(storage, options, context));
  }

  /** The pi-durable conversation of a loki chat id, if the store has it. */
  async chat(id: string, context: Context): Promise<Conversation | undefined> {
    const index = await this.harness.snapshot(ChatIndex, context);
    const conversationId = index?.chats[id];
    return conversationId === undefined ? undefined : this.harness.conversation(conversationId as ConversationId, context);
  }

  /** Every chat this store holds, as loki knows it. */
  async chats(context: Context): Promise<ChatInfo[]> {
    const index = await this.harness.snapshot(ChatIndex, context);
    const infos = await Promise.all(Object.values(index?.chats ?? {}).map((id) => this.harness.snapshot(ChatDoc, id as ConversationId, context)));
    return infos.filter((info): info is ChatInfo => info !== undefined);
  }

  /**
   * A new chat under loki's id, its index entry and info written in the commit that creates it. `agent` is what the
   * conversation runs with (model, cwd, instructions); unset fields follow the store's settings.
   */
  async createChat(
    id: string,
    options: { title?: string | null; agent?: Parameters<Harness["createConversation"]>[0]["agent"]; createdAt?: string },
    context: Context,
  ): Promise<Conversation> {
    if (await this.chat(id, context)) throw new Error(`chat ${id} already exists`);
    return this.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        ...(options.agent ? { agent: options.agent } : {}),
        init: async (tx, conversationId) => {
          (await tx.doc(ChatIndex)).chats[id] = conversationId;
          const info = await tx.doc(ChatDoc, conversationId);
          info.id = id;
          info.title = options.title ?? null;
          info.createdAt = options.createdAt ?? new Date().toISOString();
        },
      },
      context,
    );
  }

  /**
   * Write converted Letta entries into a chat, in one commit, without asking the model anything. Returns each source
   * line's new entry id, which is what a Learn cursor into the old log becomes (KTD6).
   */
  async importEntries(conversation: Conversation, entries: readonly ImportedEntry[], context: Context): Promise<Map<number, EntryId>> {
    return conversation.commit(async (tx) => {
      const bySource = new Map<string, EntryId>();
      const byLine = new Map<number, EntryId>();
      // In order: each entry's id is minted as it is appended, and a compaction names one appended before it.
      for (const entry of entries) {
        const head = entry.headSourceId === undefined ? undefined : bySource.get(entry.headSourceId);
        if (entry.kind === "pi.compaction" && head === undefined) continue;
        const written = await tx.appendEntry(conversation.id, {
          kind: entry.kind,
          ...(entry.model ? { model: entry.model as unknown as EntryRecord["model"] } : {}),
          ...(entry.data ? { data: entry.data as unknown as JsonValue } : {}),
          ...(head === undefined ? {} : { head }),
        });
        bySource.set(entry.sourceId, written.id);
        byLine.set(entry.line, written.id);
      }
      return byLine;
    }, context);
  }

  /** Every entry of a chat, oldest first, including those before its newest compaction. */
  async entries(conversation: Conversation, context: Context): Promise<EntryRecord[]> {
    const out: EntryRecord[] = [];
    let cursor: Parameters<Conversation["entries"]>[2];
    do {
      const page = await conversation.entries({ order: "ascending" }, 500, cursor, context);
      out.push(...page.items);
      cursor = page.next;
    } while (cursor !== undefined);
    return out;
  }

  close(context: Context): Promise<void> {
    return this.harness.close(context);
  }
}
