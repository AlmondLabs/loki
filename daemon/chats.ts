import { DEFAULT_MODE, isPermissionMode } from "./approvals.ts";
import type { Context } from "@earendil-works/chord";
import type { CommitPublication, ConversationId, EntryRecord } from "@earendil-works/pi-durable";
import { conversationDirName } from "../core/desk-core.ts";
import { contentText, isScheduledPrompt, stripHarnessMarkup } from "../core/harness.ts";
import { entrySteps, messageAt, type ImageNamer, type PiMessage } from "../core/attention/pi-steps.ts";
import { foldSteps, ThreadModel, type Step } from "../core/attention/thread.ts";
import type { ToolStep, TranscriptRow } from "../core/attention/transcript.ts";
import type { LocalDigest, RecentFolders } from "../core/frame-types.ts";
import { isReasoningEffort, type ReasoningEffort } from "../core/models.ts";
import type { ChatSource } from "../mod/chat-source.ts";
import type { LocalConversationInfo, LocalConversationRow } from "../mod/desks.ts";
import { ChatIndex, type AgentStore, type ChatInfo } from "./kernel/index.ts";
import type { StoreManager } from "./kernel/stores.ts";

/**
 * The daemon's chats as the mod reads them (plan 017, U6). The mod asks about chats at once and often (the chat list,
 * the Inbox, a thread's page, Learn's cursor), and pi-durable answers asynchronously, so the daemon keeps a
 * projection: each chat's details and its entries as thread steps, loaded when a store opens and kept current from
 * the store's commits, which pi-durable publishes synchronously after each one. A position in a chat is an entry's
 * index, which is what Learn's cursor counts (it counted log lines on Letta; the import converts it).
 */

/** One entry as the projection keeps it: its thread steps, and who spoke and what, for the Inbox's digest. */
interface Kept {
  steps: Step[];
  role: "user" | "assistant" | null;
  text: string;
  at: string | null;
  compaction?: true;
}

interface AgentSettings {
  model?: { provider?: string; modelId?: string };
  thinkingLevel?: string;
  cwd?: string;
}

interface Chat {
  agentId: string;
  chatId: string;
  conversationId: number;
  info: ChatInfo | null;
  settings: AgentSettings;
  entries: Kept[];
  /** The newest entry id kept: entries arrive in id order, so anything at or below it is already here. */
  lastId: number;
  /**
   * The chat's thread as folded so far, and how many entries went into it (plan 033): made when the chat is first read,
   * then fed only the entries since, so a page never folds the whole log again.
   */
  fold?: { thread: ThreadModel; entries: number };
}

/** The message an entry carries for the person to read: a branch entry's own, else the model's. */
function shownMessage(entry: Pick<EntryRecord, "kind" | "model" | "data">): PiMessage | undefined {
  if (entry.kind === "loki.branch") return (entry.data as { message?: PiMessage } | undefined)?.message;
  if (entry.kind === "pi.user" || entry.kind === "pi.assistant") return entry.model?.[0];
  return undefined;
}

function keep(entry: Pick<EntryRecord, "kind" | "model" | "data">, nameImage?: ImageNamer): Kept {
  if (entry.kind === "pi.compaction") return { steps: [], role: null, text: "", at: null, compaction: true };
  const steps = entrySteps(entry, nameImage);
  const message = shownMessage(entry);
  if (!message || (message.role !== "user" && message.role !== "assistant")) return { steps, role: null, text: "", at: null };
  const text = contentText(message.content).trim();
  return { steps, role: message.role, text: message.role === "user" ? stripHarnessMarkup(text).trim() : text, at: messageAt(message) };
}

const EFFORTS = new Set<ReasoningEffort>(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** pi's thinking level as loki's reasoning effort; none set is pi's own default, off. */
function effortOf(level: string | undefined): ReasoningEffort | null {
  if (level === undefined || level === "off") return "none";
  return level && EFFORTS.has(level as ReasoningEffort) ? (level as ReasoningEffort) : null;
}

const DIGEST_TEXT_LIMIT = 700;

/**
 * The projection: every chat's details and its entries as thread steps, kept in memory and current
 * from each store's commits, so the mod's reads (the ChatSource) answer synchronously. `follow` starts it on a StoreManager.
 */
export class ChatProjection implements ChatSource {
  private readonly chats = new Map<string, Chat>();
  private readonly listeners = new Set<(agentId: string, chatId: string, kind: "answer" | "compaction") => void>();
  private readonly unsubscribe = new Map<string, () => void>();
  private readonly attaching = new Set<Promise<void>>();
  private readonly context: Context;
  private readonly agentName: (agentId: string) => string | null;

  /** Keeps a user message's pictures as files a window loads (daemon/chat-images.ts, plan 029). */
  private readonly nameImage?: ImageNamer;

  constructor(context: Context, agentName: (agentId: string) => string | null, nameImage?: ImageNamer) {
    this.context = context;
    this.agentName = agentName;
    this.nameImage = nameImage;
  }

  /** Follow every store `stores` opens, now and after a reopen. */
  follow(stores: StoreManager): () => void {
    return stores.onOpen((agentId, store) => {
      const attached = this.attach(agentId, store).finally(() => this.attaching.delete(attached));
      this.attaching.add(attached);
    });
  }

  /** Settles once every store opened so far has its chats loaded. */
  async loaded(): Promise<void> {
    while (this.attaching.size) await Promise.allSettled([...this.attaching]);
  }

  /** Load one agent's chats and keep them current. */
  async attach(agentId: string, store: AgentStore): Promise<void> {
    this.unsubscribe.get(agentId)?.();
    for (const key of [...this.chats.keys()]) if (this.chats.get(key)?.agentId === agentId) this.chats.delete(key);
    // Subscribed first, so nothing committed while the chats load is missed; what loads later replaces what it saw.
    const pending: CommitPublication[] = [];
    let loading = true;
    this.unsubscribe.set(
      agentId,
      store.harness.subscribeCommits((publication) => (loading ? pending.push(publication) : this.apply(agentId, publication))),
    );
    const index = await store.harness.snapshot(ChatIndex, this.context);
    await Promise.all(
      Object.entries(index?.chats ?? {}).map(async ([chatId, conversationId]) => {
        const conversation = await store.harness.conversation(conversationId as ConversationId, this.context);
        if (!conversation) return;
        const [entries, info, settings] = await Promise.all([
          store.entries(conversation, this.context),
          store.chatInfo(conversation.id, this.context),
          store.agentSettings(conversation.id, this.context),
        ]);
        this.chats.set(this.key(agentId, chatId), {
          agentId,
          chatId,
          conversationId,
          info: info ?? null,
          settings: settings ?? {},
          entries: entries.map((e) => keep(e, this.nameImage)),
          lastId: entries.at(-1)?.id ?? 0,
        });
      }),
    );
    loading = false;
    // What committed while loading: entries the load already holds are skipped by their ids.
    for (const publication of pending) this.apply(agentId, publication);
  }

  /** Told each time a chat's agent answers, or its context is compacted, as it is committed (daemon/reflection.ts). */
  onEntry(listener: (agentId: string, chatId: string, kind: "answer" | "compaction") => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** How many entries a chat has, and how many of the agent's answers came at or after position `from`. */
  answers(conversationId: string, agentId: string, from: number): { entries: number; since: number } {
    const chat = this.find(conversationId, agentId);
    if (!chat) return { entries: 0, since: 0 };
    return { entries: chat.entries.length, since: chat.entries.slice(Math.max(0, from)).filter((e) => e.role === "assistant").length };
  }

  /** Whether a chat's context was compacted at or after position `from` (daemon/passes.ts: reflection runs on it then). */
  compactedSince(conversationId: string, agentId: string, from: number): boolean {
    return (
      this.find(conversationId, agentId)
        ?.entries.slice(Math.max(0, from))
        .some((e) => e.compaction === true) ?? false
    );
  }

  private key(agentId: string, chatId: string): string {
    return `${agentId}\u0000${chatId}`;
  }

  private byConversation(agentId: string, conversationId: number): Chat | undefined {
    for (const chat of this.chats.values()) if (chat.agentId === agentId && chat.conversationId === conversationId) return chat;
    return undefined;
  }

  /** One commit of one agent's store. Documents first: a chat's index entry may arrive with its first messages. */
  private apply(agentId: string, publication: CommitPublication): void {
    for (const change of publication.changes) {
      if (change.type !== "document" || change.value === null) continue;
      if (change.record.kind === ChatIndex.definition.kind) {
        const index = (change.value as { chats?: Record<string, number> }).chats ?? {};
        for (const [chatId, conversationId] of Object.entries(index)) {
          const key = this.key(agentId, chatId);
          const was = this.chats.get(key);
          if (was?.conversationId === conversationId) continue;
          // A chat set aside when it moved away keeps its log under a new key; the chat that came back is a new one.
          const moved = was ? undefined : this.byConversation(agentId, conversationId);
          if (moved) {
            this.chats.delete(this.key(agentId, moved.chatId));
            this.chats.set(key, { ...moved, chatId });
          } else this.chats.set(key, { agentId, chatId, conversationId, info: null, settings: {}, entries: [], lastId: 0 });
        }
      } else if (change.conversationId !== undefined) {
        const chat = this.byConversation(agentId, change.conversationId);
        if (!chat) continue;
        if (change.record.kind === "loki.chat") chat.info = change.value as unknown as ChatInfo;
        else if (change.record.kind === "pi.agent") chat.settings = change.value;
      }
    }
    const entries = publication.changes.flatMap((c) => (c.type === "entry" ? [c.value] : [])).sort((a, b) => a.id - b.id);
    for (const entry of entries) {
      const chat = this.byConversation(agentId, entry.conversationId);
      if (!chat || entry.id <= chat.lastId) continue;
      const kept = keep(entry, this.nameImage);
      chat.entries.push(kept);
      chat.lastId = entry.id;
      const kind = entry.kind === "pi.compaction" ? "compaction" : kept.role === "assistant" ? "answer" : null;
      if (kind) for (const listener of this.listeners) listener(agentId, chat.chatId, kind);
    }
  }

  private find(conversationId: string, agentId?: string | null): Chat | undefined {
    if (agentId) return this.chats.get(this.key(agentId, conversationId));
    if (conversationId === "default") return undefined;
    for (const chat of this.chats.values()) if (chat.chatId === conversationId) return chat;
    return undefined;
  }

  private lastMessageAt(chat: Chat): string | null {
    for (let i = chat.entries.length - 1; i >= 0; i--) if (chat.entries[i].at) return chat.entries[i].at;
    return null;
  }

  list(): LocalConversationRow[] {
    return [...this.chats.values()].map((chat) => ({
      conversationId: chat.chatId,
      agentId: chat.agentId,
      archived: chat.info?.archived === true,
      hidden: chat.info?.hidden === true,
      lastMessageAt: this.lastMessageAt(chat),
    }));
  }

  info(conversationId: string, agentId?: string | null): LocalConversationInfo | null {
    const chat = this.find(conversationId, agentId);
    if (!chat) return null;
    // A chat on an ACP agent runs on the agent's model and in the agent's own modes (plan 020).
    const engine = chat.info?.engine?.kind === "acp" ? chat.info.engine : null;
    const piModel = chat.settings.model?.provider && chat.settings.model.modelId ? `${chat.settings.model.provider}/${chat.settings.model.modelId}` : null;
    const model = engine ? `acp:${engine.agent}/${engine.model}` : piModel;
    // An agent's main chat has no title of its own; call it by the agent's name.
    const fallback = chat.chatId === "default" ? `${this.agentName(chat.agentId) ?? "agent"} · main chat` : null;
    return {
      agentId: chat.agentId,
      title: chat.info?.title?.trim() || fallback,
      lastMessageAt: this.lastMessageAt(chat),
      archived: chat.info?.archived === true,
      model,
      // An ACP chat's effort is the level chosen for it (plan 021), when loki has a word for it.
      reasoningEffort: engine ? (isReasoningEffort(engine.effort) ? engine.effort : null) : effortOf(chat.settings.thinkingLevel),
      mode: engine ? (chat.info?.mode ?? "default") : isPermissionMode(chat.info?.mode) ? chat.info.mode : DEFAULT_MODE,
      labels: chat.info?.labels ?? [],
    };
  }

  agentOf(conversationId: string): string | null {
    return this.find(conversationId)?.agentId ?? null;
  }

  /**
   * Up to `limit` rows of a chat's thread ending before position `before` (its newest when null), where they start,
   * and whether older ones remain (plan 033). A row's position is its index in the whole thread, which only grows at
   * the end, so a reader pages back by the position of the oldest row it has.
   */
  page(conversationId: string, agentId: string | null, limit: number, before: number | null = null): { rows: TranscriptRow[]; more: boolean; start: number } {
    const chat = this.find(conversationId, agentId);
    if (!chat) return { rows: [], more: false, start: 0 };
    const all = this.folded(chat);
    const end = before === null ? all.length : Math.max(0, Math.min(all.length, Math.floor(before)));
    const start = Math.max(0, end - Math.max(1, Math.floor(limit)));
    return { rows: all.slice(start, end), more: start > 0, start };
  }

  /** The whole step of the tool row at position `row` of a chat's thread, as a lean page left it out (plan 041). */
  step(conversationId: string, agentId: string | null, row: number): ToolStep | null {
    const chat = this.find(conversationId, agentId);
    const r = chat ? this.folded(chat)[row] : undefined;
    return r?.role === "tool" ? (r.tool ?? null) : null;
  }

  /** A chat's whole thread, folded once and fed only the entries that arrived since it was last read. */
  private folded(chat: Chat): readonly TranscriptRow[] {
    const fold = (chat.fold ??= { thread: new ThreadModel(), entries: 0 });
    for (; fold.entries < chat.entries.length; fold.entries++) for (const step of chat.entries[fold.entries].steps) fold.thread.apply(step);
    // Entry steps never stream, so nothing waits to settle; if one ever did, fold it whole as foldSteps would.
    return fold.thread.streaming ? foldSteps(chat.entries.flatMap((e) => e.steps)) : fold.thread.folded();
  }

  /**
   * A chat's rows from position `from` up to `to` (its end when absent), and the position they reach. Tool rows keep
   * their step (the call, its input and its result) only with `steps`: reflection reads failed calls (plan 036), Learn
   * reads words.
   */
  since(conversationId: string, agentId: string | null, from: number, to?: number, steps = false): { rows: TranscriptRow[]; lines: number } {
    const chat = this.find(conversationId, agentId);
    if (!chat) return { rows: [], lines: 0 };
    const end = Math.min(chat.entries.length, to ?? chat.entries.length);
    const rows = foldSteps(chat.entries.slice(Math.max(0, from), end).flatMap((e) => e.steps));
    return { rows: steps ? rows : rows.map(({ tool: _tool, ...row }) => row), lines: end };
  }

  digest(conversationId: string, agentId: string | null): LocalDigest {
    const chat = this.find(conversationId, agentId);
    let lastRole: LocalDigest["last_role"] = null;
    let lastAssistantText: string | null = null;
    const entries = chat?.entries ?? [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.role === "user" && e.text)
        return { last_role: lastRole ?? "user", last_assistant_text: lastAssistantText, last_ask: isScheduledPrompt(e.text) ? "schedule" : "person" };
      if (e.role === "assistant" && e.text && !lastRole) {
        lastRole = "assistant";
        lastAssistantText = e.text.slice(-DIGEST_TEXT_LIMIT);
      }
    }
    return { last_role: lastRole, last_assistant_text: lastAssistantText, last_ask: null };
  }

  folders(): RecentFolders {
    const byAgent: Record<string, string[]> = {};
    const byConversation: Record<string, string> = {};
    const recent = [...this.chats.values()].sort((a, b) => (this.lastMessageAt(b) ?? "").localeCompare(this.lastMessageAt(a) ?? ""));
    for (const chat of recent) {
      const cwd = chat.settings.cwd;
      if (!cwd) continue;
      byConversation[conversationDirName(chat.chatId, chat.agentId)] = cwd;
      const list = (byAgent[chat.agentId] ??= []);
      if (!list.includes(cwd)) list.push(cwd);
    }
    return { by_agent: byAgent, by_conversation: byConversation };
  }
}
