import { modeOf } from "../core/chat-links.ts";
import type { Context } from "@earendil-works/chord";
import type { CommitPublication, ConversationId, EntryRecord } from "@earendil-works/pi-durable";
import { conversationDirName, isMainChat, scopeFor, type Scope } from "../core/desk-core.ts";
import { contentText, isScheduledPrompt, ownText, stripHarnessMarkup } from "../core/harness.ts";
import { COMPACTION, entrySteps, messageAt, type ImageNamer, type PiMessage } from "../core/attention/pi-steps.ts";
import { foldSteps, ThreadModel, type StoredStep } from "../core/attention/thread.ts";
import type { TranscriptRow } from "../core/attention/transcript.ts";
import type { LocalDigest, RecentFolders } from "../core/frame-types.ts";
import { isReasoningEffort, type ReasoningEffort } from "../core/models.ts";
import type { ChatSource } from "../mod/chat-source.ts";
import type { LocalConversationInfo, LocalConversationRow } from "../mod/desks.ts";
import { ChatIndex, type AgentStore, type ChatInfo } from "./kernel/index.ts";
import type { StoreManager } from "./kernel/stores.ts";
import { Listeners } from "../core/listeners.ts";
import { messageOf } from "../core/errors.ts";

interface Kept {
  id: number;
  steps: StoredStep[];
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
  entriesLoaded: boolean;
  lastId: number;
  lastAt: string | null;
  lastCompactionIndex: number;
  fold?: { thread: ThreadModel; entries: number };
}

function shownMessage(entry: Pick<EntryRecord, "kind" | "model" | "data">): PiMessage | undefined {
  if (entry.kind === "loki.branch") return (entry.data as { message?: PiMessage } | undefined)?.message;
  if (entry.kind === "pi.user" || entry.kind === "pi.assistant") return entry.model?.[0];
  return undefined;
}

function keep(entry: Pick<EntryRecord, "id" | "kind" | "model" | "data">, nameImage?: ImageNamer): Kept {
  if (entry.kind === COMPACTION) return { id: entry.id, steps: entrySteps(entry), role: null, text: "", at: null, compaction: true };
  const steps = entrySteps(entry, nameImage);
  const message = shownMessage(entry);
  if (!message || (message.role !== "user" && message.role !== "assistant")) return { id: entry.id, steps, role: null, text: "", at: null };
  const text = contentText(message.content).trim();
  if (message.role !== "user") return { id: entry.id, steps, role: message.role, text, at: messageAt(message) };
  const said = stripHarnessMarkup(text).trim();
  return { id: entry.id, steps, role: message.role, text: said === text ? text : ownText(said), at: messageAt(message) };
}

// Outside (pi-ai): a thinking level left unset is pi's default, off.
function effortOfThinkingLevel(level: string | undefined): ReasoningEffort | null {
  if (level === undefined || level === "off") return "none";
  return isReasoningEffort(level) ? level : null;
}

const DIGEST_TEXT_LIMIT = 700;

const LOAD_AT_ONCE = 4;

export class ChatProjection implements ChatSource {
  private readonly chats = new Map<string, Chat>();
  private readonly byConv = new Map<string, Chat>();
  private readonly scopeCounts = new Map<Scope, number>();
  private readonly listeners = new Listeners<[agentId: string, chatId: string, kind: "answer" | "compaction"]>();
  private readonly unsubscribe = new Map<string, () => void>();
  private readonly attaching = new Set<Promise<void>>();
  private readonly stores = new Map<string, AgentStore>();
  private readonly hydrating = new Map<string, Promise<void>>();
  private readonly hydrationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly loadingEntries = new Map<string, Promise<void>>();
  private readonly context: Context;
  private readonly agentName: (agentId: string) => string | null;

  private readonly nameImage?: ImageNamer;

  constructor(context: Context, agentName: (agentId: string) => string | null, nameImage?: ImageNamer) {
    this.context = context;
    this.agentName = agentName;
    this.nameImage = nameImage;
  }

  private adjustScope(chat: Chat, delta: 1 | -1): void {
    if (chat.info?.hidden === true) return;
    const scope = scopeFor(chat.chatId, chat.agentId);
    const next = (this.scopeCounts.get(scope) ?? 0) + delta;
    if (next <= 0) this.scopeCounts.delete(scope);
    else this.scopeCounts.set(scope, next);
  }

  hasScope(scope: Scope): boolean {
    return (this.scopeCounts.get(scope) ?? 0) > 0;
  }

  follow(stores: StoreManager, report: (message: string) => void): () => void {
    return stores.onOpen((agentId, store) => {
      const attached = this.attach(agentId, store, { eagerEntries: false })
        .catch((err: unknown) => {
          this.unsubscribe.get(agentId)?.();
          this.unsubscribe.delete(agentId);
          report(`chats of ${agentId} not loaded: ${messageOf(err)}`);
        })
        .finally(() => this.attaching.delete(attached));
      this.attaching.add(attached);
    });
  }

  async metadataLoaded(): Promise<void> {
    while (this.attaching.size) await Promise.allSettled([...this.attaching]);
  }

  async loaded(): Promise<void> {
    while (this.attaching.size || this.hydrating.size) await Promise.allSettled([...this.attaching, ...this.hydrating.values()]);
  }

  ensureLoaded(conversationId: string, agentId?: string | null): Promise<void> | void {
    const chat = this.find(conversationId, agentId);
    if (chat) return chat.entriesLoaded ? undefined : this.ensureEntries(chat);
    if (!this.attaching.size) return undefined;
    return this.metadataLoaded().then(() => {
      const next = this.find(conversationId, agentId);
      return next && !next.entriesLoaded ? this.ensureEntries(next) : undefined;
    });
  }

  private ensureEntries(chat: Chat): Promise<void> {
    if (chat.entriesLoaded) return Promise.resolve();
    const key = this.key(chat.agentId, chat.chatId);
    const pending = this.loadingEntries.get(key);
    if (pending) return pending;
    const store = this.stores.get(chat.agentId);
    if (!store) return Promise.resolve();
    const task = this.hydrateChat(chat, store).finally(() => {
      if (this.loadingEntries.get(key) === task) this.loadingEntries.delete(key);
    });
    this.loadingEntries.set(key, task);
    return task;
  }

  private async hydrateChat(chat: Chat, store: AgentStore): Promise<void> {
    if (chat.entriesLoaded) return;
    const conversation = await store.harness.conversation(chat.conversationId as ConversationId, this.context);
    if (!conversation) {
      chat.entriesLoaded = true;
      return;
    }
    const entries: Kept[] = [];
    let lastId = 0;
    let lastAt: string | null = null;
    let lastCompactionIndex = -1;
    await store.eachEntry(conversation, this.context, (e) => {
      const kept = keep(e, this.nameImage);
      entries.push(kept);
      if (kept.at) lastAt = kept.at;
      if (kept.compaction) lastCompactionIndex = entries.length - 1;
      lastId = e.id;
    });
    for (const live of chat.entries) {
      if (live.id <= lastId) continue;
      entries.push(live);
      if (live.at) lastAt = live.at;
      if (live.compaction) lastCompactionIndex = entries.length - 1;
      lastId = live.id;
    }
    if (this.chats.get(this.key(chat.agentId, chat.chatId)) !== chat) return;
    chat.entries = entries;
    chat.lastId = lastId;
    chat.lastAt = lastAt;
    chat.lastCompactionIndex = lastCompactionIndex;
    chat.fold = undefined;
    chat.entriesLoaded = true;
  }

  private async hydrateAgent(agentId: string): Promise<void> {
    const waiting = [...this.chats.values()]
      .filter((c) => c.agentId === agentId && !c.entriesLoaded)
      .sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? ""));
    if (!waiting.length) return;
    const worker = async (): Promise<void> => {
      const next = waiting.shift();
      if (!next) return;
      await this.ensureEntries(next);
      return worker();
    };
    await Promise.all(Array.from({ length: Math.min(2, waiting.length) }, worker));
  }

  async attach(agentId: string, store: AgentStore, { eagerEntries = true }: { eagerEntries?: boolean } = {}): Promise<void> {
    this.unsubscribe.get(agentId)?.();
    const timer = this.hydrationTimers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      this.hydrationTimers.delete(agentId);
    }
    this.stores.set(agentId, store);
    for (const [key, chat] of [...this.chats.entries()]) {
      if (chat.agentId !== agentId) continue;
      this.adjustScope(chat, -1);
      this.chats.delete(key);
      this.byConv.delete(this.convKey(agentId, chat.conversationId));
    }
    const pending: CommitPublication[] = [];
    let loading = true;
    this.unsubscribe.set(
      agentId,
      store.harness.subscribeCommits((publication) => (loading ? pending.push(publication) : this.apply(agentId, publication))),
    );
    const index = await store.harness.snapshot(ChatIndex, this.context);
    const load = async ([chatId, conversationId]: [string, number]) => {
      const conversation = await store.harness.conversation(conversationId as ConversationId, this.context);
      if (!conversation) return;
      const entries: Kept[] = [];
      let lastId = 0;
      let lastAt: string | null = null;
      let lastCompactionIndex = -1;
      let entriesLoaded = true;
      if (eagerEntries) {
        const [, info, settings] = await Promise.all([
          store.eachEntry(conversation, this.context, (e) => {
            const kept = keep(e, this.nameImage);
            entries.push(kept);
            if (kept.at) lastAt = kept.at;
            if (kept.compaction) lastCompactionIndex = entries.length - 1;
            lastId = e.id;
          }),
          store.chatInfo(conversation.id, this.context),
          store.agentSettings(conversation.id, this.context),
        ]);
        const chat: Chat = {
          agentId,
          chatId,
          conversationId,
          info: info ?? null,
          settings: settings ?? {},
          entries,
          entriesLoaded: true,
          lastId,
          lastAt,
          lastCompactionIndex,
        };
        this.chats.set(this.key(agentId, chatId), chat);
        this.byConv.set(this.convKey(agentId, conversationId), chat);
        this.adjustScope(chat, 1);
        return;
      }
      const [tailPage, info, settings] = await Promise.all([
        conversation.entries({ order: "descending" }, 20, undefined, this.context),
        store.chatInfo(conversation.id, this.context),
        store.agentSettings(conversation.id, this.context),
      ]);
      for (let i = tailPage.items.length - 1; i >= 0; i--) {
        const e = tailPage.items[i];
        const kept = keep(e, this.nameImage);
        entries.push(kept);
        if (kept.at) lastAt = kept.at;
        if (kept.compaction) lastCompactionIndex = entries.length - 1;
        lastId = e.id;
      }
      entriesLoaded = tailPage.next === undefined;
      const chat: Chat = {
        agentId,
        chatId,
        conversationId,
        info: info ?? null,
        settings: settings ?? {},
        entries,
        entriesLoaded,
        lastId,
        lastAt,
        lastCompactionIndex,
      };
      this.chats.set(this.key(agentId, chatId), chat);
      this.byConv.set(this.convKey(agentId, conversationId), chat);
      this.adjustScope(chat, 1);
    };
    const waiting = Object.entries(index?.chats ?? {});
    await Promise.all(
      Array.from({ length: Math.min(LOAD_AT_ONCE, waiting.length) }, async () => {
        for (let next = waiting.shift(); next; next = waiting.shift()) await load(next);
      }),
    );
    loading = false;
    for (const publication of pending) this.apply(agentId, publication);
    if (!eagerEntries && [...this.chats.values()].some((c) => c.agentId === agentId && !c.entriesLoaded)) {
      const task = new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 0);
        t.unref();
        this.hydrationTimers.set(agentId, t);
      })
        .then(() => {
          this.hydrationTimers.delete(agentId);
          return this.hydrateAgent(agentId);
        })
        .catch(() => {})
        .finally(() => {
          if (this.hydrating.get(agentId) === task) this.hydrating.delete(agentId);
        });
      this.hydrating.set(agentId, task);
    }
  }

  onEntry(listener: (agentId: string, chatId: string, kind: "answer" | "compaction") => void): () => void {
    return this.listeners.add(listener);
  }

  entryCount(conversationId: string, agentId: string): number {
    return this.find(conversationId, agentId)?.entries.length ?? 0;
  }

  answers(conversationId: string, agentId: string, from: number): { entries: number; since: number } {
    const chat = this.find(conversationId, agentId);
    if (!chat) return { entries: 0, since: 0 };
    let since = 0;
    for (let i = Math.max(0, from); i < chat.entries.length; i++) if (chat.entries[i].role === "assistant") since++;
    return { entries: chat.entries.length, since };
  }

  compactedSince(conversationId: string, agentId: string, from: number): boolean {
    const chat = this.find(conversationId, agentId);
    return chat ? chat.lastCompactionIndex >= Math.max(0, from) : false;
  }

  private key(agentId: string, chatId: string): string {
    return `${agentId}\u0000${chatId}`;
  }

  private convKey(agentId: string, conversationId: number): string {
    return `${agentId}\u0000${conversationId}`;
  }

  private byConversation(agentId: string, conversationId: number): Chat | undefined {
    return this.byConv.get(this.convKey(agentId, conversationId));
  }

  private apply(agentId: string, publication: CommitPublication): void {
    const isIndex = (change: CommitPublication["changes"][number]) => change.type === "document" && change.record.kind === ChatIndex.definition.kind;
    const indexBeforeSettings = [...publication.changes].sort((a, b) => Number(isIndex(b)) - Number(isIndex(a)));
    for (const change of indexBeforeSettings) {
      if (change.type !== "document" || change.value === null) continue;
      if (change.record.kind === ChatIndex.definition.kind) {
        const index = (change.value as { chats?: Record<string, number> }).chats ?? {};
        for (const [chatId, conversationId] of Object.entries(index)) {
          const key = this.key(agentId, chatId);
          const was = this.chats.get(key);
          if (was?.conversationId === conversationId) continue;
          const moved = was ? undefined : this.byConversation(agentId, conversationId);
          if (moved) {
            this.adjustScope(moved, -1);
            this.chats.delete(this.key(agentId, moved.chatId));
            const nextChat: Chat = { ...moved, chatId };
            this.chats.set(key, nextChat);
            this.byConv.set(this.convKey(agentId, conversationId), nextChat);
            this.adjustScope(nextChat, 1);
          } else {
            const created: Chat = {
              agentId,
              chatId,
              conversationId,
              info: null,
              settings: {},
              entries: [],
              entriesLoaded: true,
              lastId: 0,
              lastAt: null,
              lastCompactionIndex: -1,
            };
            this.chats.set(key, created);
            this.byConv.set(this.convKey(agentId, conversationId), created);
            this.adjustScope(created, 1);
          }
        }
      } else if (change.conversationId !== undefined) {
        const chat = this.byConversation(agentId, change.conversationId);
        if (!chat) continue;
        if (change.record.kind === "loki.chat") {
          const nextInfo = change.value as unknown as ChatInfo;
          const wasHidden = chat.info?.hidden === true;
          const nowHidden = nextInfo.hidden;
          if (wasHidden !== nowHidden) {
            this.adjustScope(chat, -1);
            chat.info = nextInfo;
            this.adjustScope(chat, 1);
          } else chat.info = nextInfo;
        } else if (change.record.kind === "pi.agent") chat.settings = change.value;
      }
    }
    const entries = publication.changes.flatMap((c) => (c.type === "entry" ? [c.value] : [])).sort((a, b) => a.id - b.id);
    for (const entry of entries) {
      const chat = this.byConversation(agentId, entry.conversationId);
      if (!chat || entry.id <= chat.lastId) continue;
      const kept = keep(entry, this.nameImage);
      chat.entries.push(kept);
      if (kept.at) chat.lastAt = kept.at;
      if (kept.compaction) chat.lastCompactionIndex = chat.entries.length - 1;
      chat.lastId = entry.id;
      const kind = entry.kind === COMPACTION ? "compaction" : kept.role === "assistant" ? "answer" : null;
      if (kind) this.listeners.emit(agentId, chat.chatId, kind);
    }
  }

  private find(conversationId: string, agentId?: string | null): Chat | undefined {
    if (agentId) return this.chats.get(this.key(agentId, conversationId));
    if (isMainChat(conversationId)) return undefined;
    for (const chat of this.chats.values()) if (chat.chatId === conversationId) return chat;
    return undefined;
  }

  private lastMessageAt(chat: Chat): string | null {
    return chat.lastAt;
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
    const engine = chat.info?.engine?.kind === "acp" ? chat.info.engine : null;
    const piModel = chat.settings.model?.provider && chat.settings.model.modelId ? `${chat.settings.model.provider}/${chat.settings.model.modelId}` : null;
    const model = engine ? `acp:${engine.agent}/${engine.model}` : piModel;
    const fallback = isMainChat(chat.chatId) ? `${this.agentName(chat.agentId) ?? "agent"} · main chat` : null;
    return {
      agentId: chat.agentId,
      title: chat.info?.title?.trim() || fallback,
      lastMessageAt: this.lastMessageAt(chat),
      archived: chat.info?.archived === true,
      model,
      reasoningEffort: engine ? (isReasoningEffort(engine.effort) ? engine.effort : null) : effortOfThinkingLevel(chat.settings.thinkingLevel),
      mode: engine ? (chat.info?.mode ?? "default") : modeOf(chat.info?.mode),
      labels: chat.info?.labels ?? [],
      purpose: chat.info?.purpose ?? null,
      hasDraft: !!chat.info?.draft,
      draftText: chat.info?.draft?.text ?? null,
      cwd: chat.settings.cwd ?? null,
    };
  }

  agentOf(conversationId: string): string | null {
    return this.find(conversationId)?.agentId ?? null;
  }

  page(conversationId: string, agentId: string | null, limit: number, before: number | null = null): { rows: TranscriptRow[]; more: boolean; start: number } {
    const chat = this.find(conversationId, agentId);
    if (!chat) return { rows: [], more: false, start: 0 };
    const all = this.folded(chat);
    const end = before === null ? all.length : Math.max(0, Math.min(all.length, Math.floor(before)));
    const start = Math.max(0, end - Math.max(1, Math.floor(limit)));
    return { rows: all.slice(start, end), more: start > 0, start };
  }

  thread(conversationId: string, agentId: string): readonly TranscriptRow[] {
    const chat = this.find(conversationId, agentId);
    return chat ? this.folded(chat) : [];
  }

  row(conversationId: string, agentId: string | null, row: number): TranscriptRow | null {
    const chat = this.find(conversationId, agentId);
    return (chat ? this.folded(chat)[row] : undefined) ?? null;
  }

  private folded(chat: Chat): readonly TranscriptRow[] {
    const fold = (chat.fold ??= { thread: new ThreadModel(), entries: 0 });
    for (; fold.entries < chat.entries.length; fold.entries++) for (const step of chat.entries[fold.entries].steps) fold.thread.apply(step);
    return fold.thread.folded();
  }

  since(conversationId: string, agentId: string | null, from: number, to?: number, steps = false): { rows: TranscriptRow[]; lines: number } {
    const chat = this.find(conversationId, agentId);
    if (!chat) return { rows: [], lines: 0 };
    const start = Math.max(0, from);
    const end = Math.min(chat.entries.length, to ?? chat.entries.length);
    const collected: StoredStep[] = [];
    for (let i = start; i < end; i++) for (const step of chat.entries[i].steps) collected.push(step);
    const rows = foldSteps(collected);
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
    const recent = [...this.chats.values()].sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? ""));
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
