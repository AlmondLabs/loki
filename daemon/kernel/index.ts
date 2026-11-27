import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import {
  AgentDoc as PiAgentDoc,
  defineDoc,
  Harness,
  type Conversation,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type HarnessOptions,
  type HarnessSettings,
  type Storage,
  UsageDoc,
  type UsageState,
} from "@earendil-works/pi-durable";
import type { SavedDraft, Suggestion } from "../../core/frame-types.ts";
import type { SubagentStatus } from "../../core/subagents.ts";

const smallDoc = (): boolean => true;

/** loki's chat id → pi-durable conversation id, for one agent's store. */
export const ChatIndex = defineDoc<{ chats: Record<string, number> }>({
  kind: "loki.chats",
  version: 1,
  scope: "session",
  initial: () => ({ chats: {} }),
  checkpointWhen: smallDoc,
});

// oxlint-disable-next-line typescript/consistent-type-definitions -- part of ChatInfo, a pi-durable document
export type SubagentMeta = {
  id: string;
  chat_id: string;
  name: string;
  description: string;
  model: string | null;
  status: SubagentStatus;
  read_only?: boolean;
  branch?: string | null;
  worktree?: string | null;
  started_at: string;
  ended_at?: string | null;
  error?: string | null;
};

// oxlint-disable-next-line typescript/consistent-type-definitions -- a pi-durable document must be a JsonObject, and an interface with optional fields cannot extend one
export type ChatInfo = {
  id: string;
  title: string | null;
  archived: boolean;
  /** Kept out of lists: Learn's writer chats, reflection's passes, and other side threads. */
  hidden: boolean;
  createdAt: string;
  /** Which tool calls ask the person first (daemon/approvals.ts); absent, unrestricted. */
  mode?: string;
  /**
   * A mode with less power the chat runs in until it is next idle (plan 067): set when another chat's message comes
   * in, so the turn it starts can do no more than the chat that sent it could. Absent or null, none.
   */
  turn_cap?: string | null;
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
  /** The person's one line on what the chat is for, which agents read and never write (plan 049, R11); absent or null, none. */
  purpose?: string | null;
  /** A suggestion saved as a draft for this chat's message box (plan 049, KTD7); absent or null, none. */
  draft?: SavedDraft | null;
  /** The suggestions agents made in this chat (plan 049, KTD1), settled ones included; absent, none. */
  suggestions?: Suggestion[];
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
  /**
   * A helper's conversation (daemon/subagents.ts): the pi-durable conversation of the chat it works for. The chat's
   * mode is read from there on every call, so a mode changed while the helper runs holds for the helper too.
   */
  helper_for?: ConversationId;
  /**
   * Read-only guard marker (daemon/read-only-gate.ts): refuses edits, writes, and unsafe commands regardless of mode.
   */
  read_only?: boolean;
  /** Parent chat ID for a helper subagent (daemon/subagents.ts), used to list workers in the UI. */
  subagent_for?: string;
  /** Persisted metadata for a helper subagent (status, name, model, worktree, error). */
  subagent_meta?: SubagentMeta;
};

/**
 * An ACP chat's engine: the agent (daemon/acp/agents.ts), its model, the effort chosen for it (plan 021; absent or
 * null leaves the agent's own), and the agent's session id once it has one.
 */
// oxlint-disable-next-line typescript/consistent-type-definitions -- part of ChatInfo, a pi-durable document
export type ChatEngine = { kind: "acp"; agent: string; model: string; effort?: string | null; session_id: string | null; cost_so_far?: number };

export type ImportedMessage = Record<string, unknown> & { role: string; timestamp: number };

/**
 * A message the person saw but the model never did, kept for the thread with no model messages
 * (core/attention/pi-steps.ts reads it): the mark a chat move leaves (daemon/chat-move.ts).
 */
export const BRANCH_KIND = "loki.branch";

export interface ImportedEntry {
  sourceId: string;
  line: number;
  kind: "pi.user" | "pi.assistant" | "pi.tool-result" | "pi.compaction" | typeof BRANCH_KIND;
  /** Absent for a branch entry: the model does not see it. */
  model?: ImportedMessage[];
  data?: { diagnostics: [] } | { reason: "threshold" } | { message: ImportedMessage };
  /** For a compaction: the source entry its summary keeps from. */
  headSourceId?: string;
}

export const ChatDoc = defineDoc<ChatInfo>({
  kind: "loki.chat",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ id: "", title: null, archived: false, hidden: false, createdAt: "" }),
  checkpointWhen: smallDoc,
});

export const AgentInfoDoc = defineDoc<{ id: string; name: string }>({
  kind: "loki.agent",
  version: 1,
  scope: "session",
  initial: () => ({ id: "", name: "" }),
  checkpointWhen: smallDoc,
});

export interface UsageAdd {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  cost: number;
}

/**
 * A message sent while a run fails is answered next, on its own (plan 039). pi-durable 1.4's default, `keep`, leaves it
 * unshown until the person sends another, which reads as a message lost.
 */
const AFTER_FAILED_RUN: HarnessSettings = { afterFailedRun: "continue" };

export const READ_ONLY_EXTENSION = "loki.read-only";
const ADDED_ONLY: ReadonlySet<string> = new Set([READ_ONLY_EXTENSION]);

const chosenByDefault = (registry: StoreOptions["registry"]): HarnessSettings["extensions"] =>
  registry
    .snapshot()
    .installed()
    .filter((extension) => !ADDED_ONLY.has(extension.name));

export type StoreOptions = Pick<HarnessOptions, "models" | "registry" | "settings" | "env" | "onReport" | "now">;

export class AgentStore {
  readonly harness: Harness;

  private constructor(harness: Harness) {
    this.harness = harness;
  }

  static async open(where: { file: string } | { storage: Storage }, options: StoreOptions, context: Context): Promise<AgentStore> {
    const storage =
      "storage" in where ? where.storage : await (await import("@earendil-works/pi-durable/storage/sqlite/node")).openNodeSqliteStorage(where.file);
    const given = options.settings;
    const current = typeof given === "function" ? given : () => given;
    const settings = (): HarnessSettings => ({ ...AFTER_FAILED_RUN, extensions: chosenByDefault(options.registry), ...current() });
    return new AgentStore(await Harness.open(storage, { ...options, settings }, context));
  }

  async setAgent(agent: { id: string; name: string }, context: Context): Promise<void> {
    const known = await this.harness.snapshot(AgentInfoDoc, context);
    if (known?.id === agent.id && known.name === agent.name) return;
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(AgentInfoDoc);
      doc.id = agent.id;
      doc.name = agent.name;
    }, context);
  }

  async chat(id: string, context: Context): Promise<Conversation | undefined> {
    const index = await this.harness.snapshot(ChatIndex, context);
    const conversationId = index?.chats[id];
    return conversationId === undefined ? undefined : this.harness.conversation(conversationId as ConversationId, context);
  }

  chatInfo(conversationId: ConversationId, context: Context): Promise<Readonly<ChatInfo> | undefined> {
    return this.harness.snapshot(ChatDoc, conversationId, context);
  }

  agentSettings(conversationId: ConversationId, context: Context): Promise<Readonly<object> | undefined> {
    return this.harness.snapshot(PiAgentDoc, conversationId, context);
  }

  async updateChat(
    id: string,
    change: Partial<
      Pick<
        ChatInfo,
        "title" | "archived" | "hidden" | "mode" | "turn_cap" | "engine" | "labels" | "purpose" | "draft" | "suggestions" | "placed" | "moved" | "subagent_meta"
      >
    >,
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
      if (change.turn_cap !== undefined) info.turn_cap = change.turn_cap;
      if (change.engine !== undefined) info.engine = change.engine;
      if (change.labels !== undefined) info.labels = change.labels;
      if (change.purpose !== undefined) info.purpose = change.purpose;
      if (change.draft !== undefined) info.draft = change.draft;
      if (change.suggestions !== undefined) info.suggestions = change.suggestions;
      if (change.placed !== undefined) info.placed = change.placed;
      if (change.moved !== undefined) info.moved = change.moved;
      if (change.subagent_meta !== undefined) info.subagent_meta = change.subagent_meta;
    }, context);
    return true;
  }

  async saveDraft(id: string, draft: SavedDraft, context: Context): Promise<"saved" | "held" | "missing"> {
    const chat = await this.chat(id, context);
    if (!chat) return "missing";
    const out = { held: false };
    await chat.commit(async (tx) => {
      const info = await tx.doc(ChatDoc, chat.id);
      if (info.draft && info.draft.suggestion_id !== draft.suggestion_id) out.held = true;
      else info.draft = draft;
    }, context);
    return out.held ? "held" : "saved";
  }

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

  usage(conversationId: ConversationId, context: Context): Promise<Readonly<UsageState> | undefined> {
    return this.harness.snapshot(UsageDoc, conversationId, context);
  }

  async chatConversations(context: Context): Promise<ConversationId[]> {
    const index = await this.harness.snapshot(ChatIndex, context);
    return Object.values(index?.chats ?? {}).map((id) => id as ConversationId);
  }

  async chats(context: Context): Promise<ChatInfo[]> {
    const index = await this.harness.snapshot(ChatIndex, context);
    const infos = await Promise.all(Object.values(index?.chats ?? {}).map((id) => this.harness.snapshot(ChatDoc, id as ConversationId, context)));
    return infos.filter((info): info is ChatInfo => info !== undefined);
  }

  async createChat(
    id: string,
    options: {
      title?: string | null;
      hidden?: boolean;
      agent?: Parameters<Harness["createConversation"]>[0]["agent"];
      createdAt?: string;
      mode?: string;
    },
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
          if (options.mode !== undefined) info.mode = options.mode;
        },
      },
      context,
    );
  }

  async importEntries(conversation: Conversation, entries: readonly ImportedEntry[], context: Context): Promise<Map<number, EntryId>> {
    return conversation.commit(async (tx) => {
      const bySource = new Map<string, EntryId>();
      const byLine = new Map<number, EntryId>();
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

  async appendEntries(
    conversation: Conversation,
    entries: ReadonlyArray<{ kind: "pi.user" | "pi.assistant" | "pi.tool-result" | "pi.compaction"; message: Record<string, unknown> }>,
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
      const { input, output, cacheRead, cacheWrite, reasoning = 0 } = usage.add;
      const existingReasoning = Object.entries(was).find(([k]) => k === "reasoning")?.[1];
      const totalReasoning = (typeof existingReasoning === "number" ? existingReasoning : 0) + reasoning;
      const extraReasoning = totalReasoning > 0 ? { reasoning: totalReasoning } : {};
      doc.models[usage.model] = {
        ...was,
        ...extraReasoning,
        input: was.input + input,
        output: was.output + output,
        cacheRead: was.cacheRead + cacheRead,
        cacheWrite: was.cacheWrite + cacheWrite,
        totalTokens: was.totalTokens + input + output + cacheRead + cacheWrite + reasoning,
        cost: { ...was.cost, total: was.cost.total + usage.add.cost },
      };
    }, context);
  }

  async entries(conversation: Conversation, context: Context): Promise<EntryRecord[]> {
    const out: EntryRecord[] = [];
    await this.eachEntry(conversation, context, (entry) => out.push(entry));
    return out;
  }

  async eachEntry(conversation: Conversation, context: Context, fn: (entry: EntryRecord) => void, after?: EntryId): Promise<void> {
    let cursor: Parameters<Conversation["entries"]>[2];
    do {
      const page = await conversation.entries({ order: "ascending", ...(after === undefined ? {} : { minEntryId: after }) }, 500, cursor, context);
      for (const entry of page.items) if (entry.id !== after) fn(entry);
      cursor = page.next;
    } while (cursor !== undefined);
  }

  async newestEntryId(conversation: Conversation, context: Context): Promise<EntryId | undefined> {
    const page = await conversation.entries({ order: "descending" }, 1, undefined, context);
    return page.items[0]?.id;
  }

  close(context: Context): Promise<void> {
    return this.harness.close(context);
  }
}
