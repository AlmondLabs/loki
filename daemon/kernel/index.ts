import type { Context, JsonValue } from "@earendil-works/chord";
import {
  AgentDoc as PiAgentDoc,
  defineDoc,
  Harness,
  type Conversation,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type HarnessOptions,
  type Storage,
  UsageDoc,
  type UsageState,
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
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- a pi-durable document must be a JsonObject, and an interface with optional fields cannot extend one
export type ChatInfo = {
  id: string;
  title: string | null;
  archived: boolean;
  /** Kept out of lists: Learn's writer chats, reflection's passes, and side threads imported from Letta. */
  hidden: boolean;
  createdAt: string;
  /** Which tool calls ask the person first (daemon/approvals.ts); absent, unrestricted. */
  mode?: string;
  /**
   * The MCP tools that existed when loki last set this chat's tool filter (daemon/mcp/index.ts). One missing from the
   * filter's hidden list and in here was loaded by mcp_search; one not in here is new, and starts hidden. Emptied by
   * /clear and a compaction, which unloads every MCP tool the chat had.
   */
  mcpKnown?: string[];
  /**
   * Where the chat runs (plan 020): absent, on loki's own engine (pi-durable and a provider's model); `acp`, on an ACP
   * agent loki starts (daemon/acp/), with the model it was given and the agent's session once one is open. Set before
   * the chat's first message and fixed after it (KD4).
   */
  engine?: ChatEngine | null;
  /** The person's labels on the chat (plan 022), as core/labels.ts names them; absent, none. */
  labels?: string[];
  /**
   * Put on this Mac on purpose (plan 023, addendum A2): moved here by hand, or started here away from its agent's home.
   * The hand-over of an agent's chats to its home leaves it where it is.
   */
  placed?: boolean;
  /**
   * Moved here from another Mac, and the agent not told yet (addendum A5): told with the person's next message, then
   * cleared. `files_left`: files attached before the move, which stayed on the Mac it came from.
   */
  moved?: { from: string; to: string; files_left: number } | null;
};

/**
 * An ACP chat's engine: the agent (daemon/acp/agents.ts), its model, the effort chosen for it (plan 021; absent or
 * null leaves the agent's own), and the agent's session id once it has one.
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- part of ChatInfo, a pi-durable document
export type ChatEngine = { kind: "acp"; agent: string; model: string; effort?: string | null; session_id: string | null };

/** The pi-durable document that holds a chat's ChatInfo, one per conversation, keeping only its latest state; a fork starts from the empty one. */
export const ChatDoc = defineDoc<ChatInfo>({
  kind: "loki.chat",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ id: "", title: null, archived: false, hidden: false, createdAt: "" }),
});

/** Which agent a store belongs to, so a tool or section can name it without asking the daemon. */
export const AgentInfoDoc = defineDoc<{ id: string; name: string }>({
  kind: "loki.agent",
  version: 1,
  scope: "session",
  initial: () => ({ id: "", name: "" }),
});

/** Tokens and cost to add to a chat's totals: what an ACP agent reported for a turn (AgentStore.appendEntries). */
export interface UsageAdd {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Dollars, as the agent estimated them; the agent gives no split by token type. */
  cost: number;
}

/** The Harness options a store is opened with; the storage is the store's own (AgentStore.open). */
export type StoreOptions = Pick<HarnessOptions, "models" | "registry" | "settings" | "env" | "onReport" | "now">;

/** One agent's chats on one pi-durable Harness. */
export class AgentStore {
  readonly harness: Harness;

  private constructor(harness: Harness) {
    this.harness = harness;
  }

  /**
   * Open a store over `storage`, or over the SQLite file at `file`. The SQLite backend is Node's own `node:sqlite`,
   * loaded only when a file is asked for, so tests on memory storage need no SQLite.
   */
  static async open(where: { file: string } | { storage: Storage }, options: StoreOptions, context: Context): Promise<AgentStore> {
    const storage =
      "storage" in where ? where.storage : await (await import("@earendil-works/pi-durable/storage/sqlite/node")).openNodeSqliteStorage(where.file);
    return new AgentStore(await Harness.open(storage, options, context));
  }

  /** Record which agent this store is, once, or when its name changes. */
  async setAgent(agent: { id: string; name: string }, context: Context): Promise<void> {
    const known = await this.harness.snapshot(AgentInfoDoc, context);
    if (known?.id === agent.id && known.name === agent.name) return;
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(AgentInfoDoc);
      doc.id = agent.id;
      doc.name = agent.name;
    }, context);
  }

  /** The pi-durable conversation of a loki chat id, if the store has it. */
  async chat(id: string, context: Context): Promise<Conversation | undefined> {
    const index = await this.harness.snapshot(ChatIndex, context);
    const conversationId = index?.chats[id];
    return conversationId === undefined ? undefined : this.harness.conversation(conversationId as ConversationId, context);
  }

  /** What loki keeps about one conversation, if it is a chat of loki's. */
  chatInfo(conversationId: ConversationId, context: Context): Promise<Readonly<ChatInfo> | undefined> {
    return this.harness.snapshot(ChatDoc, conversationId, context);
  }

  /** What a conversation runs with (model, thinking level, folder), as pi-durable stores it. */
  agentSettings(conversationId: ConversationId, context: Context): Promise<Readonly<object> | undefined> {
    return this.harness.snapshot(PiAgentDoc, conversationId, context);
  }

  /** Change what loki keeps about a chat: its title, or whether it is archived or hidden. */
  async updateChat(
    id: string,
    change: Partial<Pick<ChatInfo, "title" | "archived" | "hidden" | "mode" | "engine" | "labels" | "placed" | "moved">>,
    context: Context,
  ): Promise<boolean> {
    const chat = await this.chat(id, context);
    if (!chat) return false;
    await chat.commit(async (tx) => {
      const info = await tx.doc(ChatDoc, chat.id);
      if (change.title !== undefined) info.title = change.title;
      if (change.archived !== undefined) info.archived = change.archived;
      if (change.hidden !== undefined) info.hidden = change.hidden;
      if (change.mode !== undefined) info.mode = change.mode;
      if (change.engine !== undefined) info.engine = change.engine;
      if (change.labels !== undefined) info.labels = change.labels;
      if (change.placed !== undefined) info.placed = change.placed;
      if (change.moved !== undefined) info.moved = change.moved;
    }, context);
    return true;
  }

  /**
   * Set aside the copy of a chat this Mac let go when it moved away (plan 023, addendum A4), so the chat can come back
   * under its own id: the copy stays, hidden, under a new key, and its usage is still counted. False when there is none.
   */
  async retireChat(id: string, context: Context): Promise<boolean> {
    const chat = await this.chat(id, context);
    if (!chat) return false;
    const key = `${id}~moved-${Date.now().toString(36)}`;
    await chat.commit(async (tx) => {
      const index = await tx.doc(ChatIndex);
      index.chats[key] = chat.id;
      index.chats = Object.fromEntries(Object.entries(index.chats).filter(([k]) => k !== id));
      const info = await tx.doc(ChatDoc, chat.id);
      info.id = key;
      info.hidden = true;
    }, context);
    return true;
  }

  /** A conversation's token and cost totals so far, by model and by tool (pi-durable's `pi.usage`). */
  usage(conversationId: ConversationId, context: Context): Promise<Readonly<UsageState> | undefined> {
    return this.harness.snapshot(UsageDoc, conversationId, context);
  }

  /** The conversation of every chat this store holds; a helper's child conversation is not among them. */
  async chatConversations(context: Context): Promise<ConversationId[]> {
    const index = await this.harness.snapshot(ChatIndex, context);
    return Object.values(index?.chats ?? {}).map((id) => id as ConversationId);
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
    options: { title?: string | null; hidden?: boolean; agent?: Parameters<Harness["createConversation"]>[0]["agent"]; createdAt?: string },
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
          info.hidden = options.hidden ?? false;
          info.createdAt = options.createdAt ?? new Date().toISOString();
        },
      },
      context,
    );
  }

  /**
   * Write converted Letta entries into a chat, in one commit, without asking the model anything. Returns each source
   * line's new entry id, which is what a Learn cursor into the old log becomes (daemon/import/letta.ts).
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

  /**
   * Write a chat's messages as they happen elsewhere (an ACP agent's turn, plan 020), without asking pi's model
   * anything, in one commit. `usage`, when given, is added to the chat's `pi.usage` totals under `model` in the same
   * commit, so the usage ledger (daemon/usage.ts) counts it as it counts loki's own turns.
   */
  async appendEntries(
    conversation: Conversation,
    entries: ReadonlyArray<{ kind: "pi.user" | "pi.assistant" | "pi.tool-result"; message: Record<string, unknown> }>,
    usage: { model: string; add: UsageAdd } | null,
    context: Context,
  ): Promise<void> {
    await conversation.commit(async (tx) => {
      for (const entry of entries) {
        await tx.appendEntry(conversation.id, {
          kind: entry.kind,
          model: [entry.message] as unknown as EntryRecord["model"],
          ...(entry.kind === "pi.tool-result" ? { data: { diagnostics: [] } } : {}),
        });
      }
      if (!usage) return;
      const doc = await tx.doc(UsageDoc, conversation.id);
      const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      const was = usage.model in doc.models ? doc.models[usage.model] : zero;
      const { input, output, cacheRead, cacheWrite } = usage.add;
      doc.models[usage.model] = {
        ...was,
        input: was.input + input,
        output: was.output + output,
        cacheRead: was.cacheRead + cacheRead,
        cacheWrite: was.cacheWrite + cacheWrite,
        totalTokens: was.totalTokens + input + output + cacheRead + cacheWrite,
        cost: { ...was.cost, total: was.cost.total + usage.add.cost },
      };
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
