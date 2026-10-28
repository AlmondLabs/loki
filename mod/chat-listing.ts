import { SHARED_SCOPE, type Scope } from "../core/desk-core.ts";
import type { DeskInfo, DeskSummary, InboxRow, LocalAgent } from "../core/frame-types.ts";
import { reasoningEffortFromSettings } from "../core/models.ts";
import { isLearnTitle } from "../core/recall/model.ts";
import { backendDir, readLocalAgent } from "./agents.ts";
import type { ChatSource } from "./chat-source.ts";
import { agentHasMemory, hiddenScopes, type DeskRegistry, type LocalConversationRow } from "./desks.ts";
import { sortDesks } from "./frames/desks.ts";
import { log } from "./log.ts";

/** A desk's facts with when its chat last spoke, for sorting the chat list. */
export type DeskFacts = DeskInfo & { last_active: string | null };

/**
 * One list's view of the agents (plan 040): each agent's record read, and its memory folder looked for, once however
 * many of its chats the list holds. A list makes its own, so a record changed on disk shows in the next one.
 */
interface Agents {
  record(agentId: string): LocalAgent | null;
  hasMemory(agentId: string): boolean;
}

/** The agent's name as its record gives it; null when the record has none (readLocalAgent then falls back to the id). */
const nameOf = (agent: LocalAgent | null): string | null => (agent && agent.name !== agent.id ? agent.name : null);

/** The frame that tells open tabs a chat's title, status, agent or model changed. */
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

/**
 * Which of this Mac's chats show, and what each row says (glossary: Chat list, Inbox). A chat shows when it is one of
 * the person's own: not hidden, not a background pass's, and of an agent the person has (one with a desk here, or one
 * with memory and a record), never a helper agent's. The chat list also shows archived chats, lessons and the desks of
 * canvases with no chat; the inbox shows only open chats that are not lessons. Both lists, another Mac's view of this
 * one (mod/frames/peers.ts) and the `desk_title` push read their rows here, so a rule changes in one place.
 *
 * Listing the chats also tidies the desk registry: desks an older loki kept for helper agents or the passes' chats are
 * forgotten as the list is read.
 */
export class ChatListing {
  private readonly opts: {
    chats: ChatSource;
    desks: DeskRegistry;
    /** The scopes with a saved layout here, and the canvas files by scope (all of them, when no scope is given). */
    layouts: () => Iterable<Scope>;
    widgets: { entries: (scope?: Scope) => ReadonlyArray<{ scope: Scope }> };
    /** Pinned chats, as `agent_id/conversation_id`. */
    pins: () => Set<string>;
    /** Which conversations are the background passes' (reflection's, Learn's): the rule as it stands, for one list. */
    passChats: () => (conversationId: string) => boolean;
    activeScope: () => Scope;
    /** Where agents' records and memory folders live; the daemon's own by default. */
    backendDir?: string;
    /** Reads an agent's record; readLocalAgent in backendDir by default. */
    readAgent?: (agentId: string) => LocalAgent | null;
  };

  constructor(opts: ChatListing["opts"]) {
    this.opts = opts;
  }

  /** This Mac's chat list: every desk with its facts, the shared desk first. */
  desks(): DeskSummary[] {
    const { chats, desks, widgets } = this.opts;
    const agents = this.agents();
    const passChat = this.opts.passChats();
    this.tidy(agents, passChat);
    const scopes = new Set<Scope>([SHARED_SCOPE, ...this.opts.layouts(), ...desks.all().map((d) => d.scope)]);
    for (const e of widgets.entries()) scopes.add(e.scope);
    const rows = chats.list();
    for (const c of this.shown(rows, agents, passChat)) scopes.add(desks.remember(c.conversationId, c.agentId));
    // A chat let go to another Mac lives there now, though its canvas may still be here.
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

  /**
   * This Mac's inbox: every open chat of the person's own agents, main chats included, however old, newest first. A
   * chat leaves the inbox by being archived, not by going quiet, and a lesson is precisely the thing that can wait: a
   * row in the chat list, never an inbox card.
   */
  inbox(): InboxRow[] {
    const { chats } = this.opts;
    const agents = this.agents();
    const out: InboxRow[] = [];
    for (const c of this.shown(chats.list(), agents, this.opts.passChats())) {
      if (c.archived) continue;
      const info = chats.info(c.conversationId, c.agentId);
      if (isLearnTitle(info?.title)) continue;
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
        ...chats.digest(c.conversationId, c.agentId),
      });
    }
    return out.sort((a, b) => (b.last_message_at ?? "").localeCompare(a.last_message_at ?? ""));
  }

  /** One desk's facts: its chat's title and status, its agent, and the model and mode it runs on. */
  info(scope: Scope, agents = this.agents()): DeskFacts {
    const none = { title: null, status: "none", agent_name: null, agent_id: null, model: null, reasoning_effort: null, last_active: null } as const;
    if (scope === SHARED_SCOPE) return { ...none, title: "shared" };
    const rt = this.opts.desks.get(scope);
    if (!rt) return none;
    const agent = agents.record(rt.agent_id);
    const agentModel = agent?.model ?? null;
    const agentEffort = reasoningEffortFromSettings(agent?.model_settings);
    const info = this.opts.chats.info(rt.conversation_id, rt.agent_id);
    const facts = { agent_name: nameOf(agent), agent_id: rt.agent_id, mode: info?.mode ?? "unrestricted" };
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

  /** The `desk_title` push for a desk, once its chat has a title; null before. */
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

  /** The person's own chats among `rows`: the rule both lists share. */
  private shown(rows: LocalConversationRow[], agents: Agents, passChat: (conversationId: string) => boolean): LocalConversationRow[] {
    const withDesk = new Set(this.opts.desks.all().map((d) => d.agent_id));
    return rows.filter(
      (c) =>
        !c.hidden &&
        !passChat(c.conversationId) &&
        // A deleted agent leaves its memory folder behind: its record must still exist too.
        (withDesk.has(c.agentId) || (agents.hasMemory(c.agentId) && agents.record(c.agentId) !== null)),
    );
  }

  /** Forget the desks an older loki kept for the passes' chats, so they do not come back. */
  private tidy(agents: Agents, passChat: (conversationId: string) => boolean): void {
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
