import { SHARED_SCOPE, type Scope } from "../core/desk-core.ts";
import type { DeskInfo, DeskSummary, InboxRow, LocalAgent, ReplyProposal } from "../core/frame-types.ts";
import { DEFAULT_MODE } from "../core/chat-links.ts";
import { reasoningEffortFromSettings } from "../core/models.ts";
import { isLearnTitle } from "../core/recall/model.ts";
import { backendDir, readLocalAgent } from "./agents.ts";
import type { ChatSource } from "./chat-source.ts";
import { agentHasMemory, hiddenScopes, type DeskRegistry, type LocalConversationRow } from "./desks.ts";
import { sortDesks } from "./frames/desks.ts";
import { log } from "./log.ts";

export type DeskFacts = DeskInfo & { last_active: string | null };

interface Agents {
  record(agentId: string): LocalAgent | null;
  hasMemory(agentId: string): boolean;
}

const nameOf = (agent: LocalAgent | null): string | null => (agent && agent.name !== agent.id ? agent.name : null);

export interface DeskTitleFrame {
  type: "desk_title";
  scope: Scope;
  title: string;
  status: DeskInfo["status"];
  agent_name: string | null;
  model: string | null;
  reasoning_effort: DeskInfo["reasoning_effort"];
  mode: string | null;
}

export class ChatListing {
  private readonly opts: {
    chats: ChatSource;
    desks: DeskRegistry;
    layouts: () => Iterable<Scope>;
    widgets: { entries: (scope?: Scope) => ReadonlyArray<{ scope: Scope }> };
    pins: () => Set<string>;
    passChats: () => (conversationId: string) => boolean;
    activeScope: () => Scope;
    backendDir?: string;
    readAgent?: (agentId: string) => LocalAgent | null;
    outside?: () => InboxRow[];
    replies?: (agentId: string, conversationId: string) => ReplyProposal[];
  };

  constructor(opts: ChatListing["opts"]) {
    this.opts = opts;
  }

  desks(): DeskSummary[] {
    const { chats, desks, widgets } = this.opts;
    const agents = this.agents();
    const passChat = this.opts.passChats();
    this.tidy(passChat);
    const scopes = new Set<Scope>([SHARED_SCOPE, ...this.opts.layouts(), ...desks.all().map((d) => d.scope)]);
    for (const e of widgets.entries()) scopes.add(e.scope);
    const rows = chats.list();
    for (const c of this.shown(rows, agents, passChat)) scopes.add(desks.remember(c.conversationId, c.agentId));
    const hidden = hiddenScopes(rows);
    const pins = this.opts.pins();
    const active = this.opts.activeScope();
    return sortDesks(
      [...scopes]
        .filter((scope) => !hidden.has(scope))
        .map((scope) => {
          const info = this.info(scope, agents);
          const rt = desks.get(scope);
          return {
            scope,
            title: info.title,
            status: info.status,
            agent_name: info.agent_name,
            agent_id: info.agent_id,
            conversation_id: rt?.conversation_id ?? null,
            pinned: pins.has(`${rt?.agent_id ?? ""}/${rt?.conversation_id ?? ""}`),
            model: info.model,
            reasoning_effort: info.reasoning_effort,
            mode: info.mode ?? null,
            labels: info.labels ?? [],
            purpose: info.purpose ?? null,
            has_draft: info.has_draft ?? false,
            cwd: info.cwd ?? null,
            widgets: widgets.entries(scope).length,
            active: scope === active,
            last_active: info.last_active,
          };
        }),
    );
  }

  inbox(): InboxRow[] {
    const { chats } = this.opts;
    const agents = this.agents();
    const out: InboxRow[] = [];
    for (const c of this.shown(chats.list(), agents, this.opts.passChats())) {
      if (c.archived) continue;
      const info = chats.info(c.conversationId, c.agentId);
      if (isLearnTitle(info?.title)) continue;
      const replies = this.opts.replies?.(c.agentId, c.conversationId) ?? [];
      out.push({
        id: c.conversationId,
        agent_id: c.agentId,
        agent_name: nameOf(agents.record(c.agentId)),
        title: info?.title ?? null,
        last_message_at: c.lastMessageAt,
        archived: false,
        labels: info?.labels ?? [],
        purpose: info?.purpose ?? null,
        has_draft: info?.hasDraft ?? false,
        draft_text: info?.draftText ?? null,
        cwd: info?.cwd ?? null,
        ...(replies.length ? { reply_proposals: replies } : {}),
        ...chats.digest(c.conversationId, c.agentId),
      });
    }
    out.push(...(this.opts.outside?.() ?? []));
    return out.sort((a, b) => (b.last_message_at ?? "").localeCompare(a.last_message_at ?? ""));
  }

  info(scope: Scope, agents = this.agents()): DeskFacts {
    const none = { title: null, status: "none", agent_name: null, agent_id: null, model: null, reasoning_effort: null, last_active: null } as const;
    if (scope === SHARED_SCOPE) return { ...none, title: "shared" };
    const rt = this.opts.desks.get(scope);
    if (!rt) return none;
    const agent = agents.record(rt.agent_id);
    const agentModel = agent?.model ?? null;
    const agentEffort = reasoningEffortFromSettings(agent?.model_settings);
    const info = this.opts.chats.info(rt.conversation_id, rt.agent_id);
    const facts = { agent_name: nameOf(agent), agent_id: rt.agent_id, mode: info?.mode ?? DEFAULT_MODE };
    if (!info) return { ...facts, title: null, status: "deleted", model: agentModel, reasoning_effort: agentEffort, last_active: null };
    return {
      ...facts,
      title: info.title,
      status: info.archived ? "archived" : "live",
      model: info.model ?? agentModel,
      reasoning_effort: info.model ? info.reasoningEffort : (info.reasoningEffort ?? agentEffort),
      labels: info.labels,
      purpose: info.purpose,
      has_draft: info.hasDraft,
      cwd: info.cwd,
      last_active: info.lastMessageAt,
    };
  }

  titleFrame(scope: Scope): DeskTitleFrame | null {
    const info = this.info(scope);
    if (!info.title) return null;
    return {
      type: "desk_title",
      scope,
      title: info.title,
      status: info.status,
      agent_name: info.agent_name,
      model: info.model,
      reasoning_effort: info.reasoning_effort,
      mode: info.mode ?? null,
    };
  }

  private shown(rows: LocalConversationRow[], agents: Agents, passChat: (conversationId: string) => boolean): LocalConversationRow[] {
    const withDesk = new Set(this.opts.desks.all().map((d) => d.agent_id));
    return rows.filter(
      (c) => !c.hidden && !passChat(c.conversationId) && (withDesk.has(c.agentId) || (agents.hasMemory(c.agentId) && agents.record(c.agentId) !== null)),
    );
  }

  private tidy(passChat: (conversationId: string) => boolean): void {
    const { desks } = this.opts;
    const evicted = desks.forgetConversations(passChat);
    if (evicted) log("desks:evict-pass-chats", { evicted });
  }

  private agents(): Agents {
    const dir = this.dir();
    const read = this.opts.readAgent ?? ((agentId: string) => readLocalAgent(agentId, dir));
    const records = new Map<string, LocalAgent | null>();
    const memory = new Map<string, boolean>();
    return {
      record: (agentId) => {
        if (!records.has(agentId)) records.set(agentId, read(agentId));
        return records.get(agentId) ?? null;
      },
      hasMemory: (agentId) => {
        if (!memory.has(agentId)) memory.set(agentId, agentHasMemory(agentId, dir));
        return memory.get(agentId) === true;
      },
    };
  }

  private dir(): string {
    return this.opts.backendDir ?? backendDir();
  }
}
