import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Scope } from "../core/desk-core.ts";
import { backendName, scopeFor } from "../core/desk-core.ts";
import { migrateKeys } from "../core/snake-keys.ts";
import { backendDir as defaultBackendDir } from "./agents.ts";
import type { ReasoningEffort } from "../core/models.ts";

/** A chat by its agent and conversation ids, as the desk registry keeps it. */
export interface Runtime {
  agent_id: string;
  conversation_id: string;
}

/**
 * Which chat each desk belongs to, by scope, kept in state/desks.json. A cache: a desk it has not seen is resolved from
 * its scope and written down. Writes are best effort, and an unreadable file starts it empty.
 */
export class DeskRegistry {
  private byScope = new Map<Scope, Runtime>();
  private readonly path: string;
  private readonly agentOf: (conversationId: string) => string | null;

  /** `agentOf` names the agent of a conversation it has not seen (the daemon's chats, mod/chat-source.ts). */
  constructor(path: string, agentOf: (conversationId: string) => string | null) {
    this.path = path;
    this.agentOf = agentOf;
    try {
      // Saved camelCase (agentId, conversationId) before October 2026: renamed here and written back once.
      const { value: parsed, changed } = migrateKeys(JSON.parse(readFileSync(path, "utf8")) as Record<string, Partial<Runtime> | null>);
      let rewritten = changed;
      for (const [k, v] of Object.entries(parsed)) {
        if (!v?.agent_id || !v.conversation_id) continue;
        const rt: Runtime = { ...v, agent_id: v.agent_id, conversation_id: v.conversation_id };
        // One scope per conversation: an older loki filed a main chat under the bare scope "default";
        // today it is `default-<agentId>`. Fold legacy keys onto the canonical one so no desk shows twice.
        const canonical = scopeFor(rt.conversation_id, rt.agent_id);
        if (k !== canonical) {
          rewritten = true;
          if (!this.byScope.has(canonical)) this.byScope.set(canonical, rt);
          continue;
        }
        this.byScope.set(k, rt);
      }
      if (rewritten) this.persist();
    } catch {
      // fresh
    }
  }

  /** Record a conversation; returns its scope. */
  remember(conversationId: string, agentId: string | null | undefined): Scope {
    const agent = agentId ?? this.byScope.get(scopeFor(conversationId))?.agent_id ?? this.agentOf(conversationId);
    const scope = scopeFor(conversationId, agent);
    const prev = this.byScope.get(scope);
    if (!agent) return scope;
    if (prev?.agent_id !== agent || prev.conversation_id !== conversationId) {
      this.byScope.set(scope, { agent_id: agent, conversation_id: conversationId });
      this.persist();
    }
    return scope;
  }

  /**
   * The runtime behind a desk. The registry is a cache of what turn_start /
   * turn_start told us; a desk it has never seen is still resolvable from the
   * scope itself: `default-<agentId>` names its agent, and any other scope is
   * a conversation id whose owner the daemon's chats know.
   */
  get(scope: Scope): Runtime | undefined {
    const known = this.byScope.get(scope);
    if (known) return known;
    if (scope === "shared") return undefined;
    let rt: Runtime | null = null;
    if (scope.startsWith("default-")) rt = { agent_id: scope.slice("default-".length), conversation_id: "default" };
    else {
      const agent = this.agentOf(scope);
      if (agent) rt = { agent_id: agent, conversation_id: scope };
    }
    if (!rt) return undefined;
    this.byScope.set(scope, rt);
    this.persist();
    return rt;
  }

  all(): Array<{ scope: Scope } & Runtime> {
    return [...this.byScope.entries()].map(([scope, rt]) => ({ scope, ...rt }));
  }

  /** Drop every desk whose conversation `test` names (the background passes' own). Returns how many went. */
  forgetConversations(test: (conversationId: string) => boolean): number {
    let n = 0;
    for (const [scope, rt] of this.byScope) {
      if (!test(rt.conversation_id)) continue;
      this.byScope.delete(scope);
      n++;
    }
    if (n) this.persist();
    return n;
  }

  /** Drop every desk of an agent (a subagent that slipped in through turn_start). Returns how many went. */
  forgetAgent(agentId: string): number {
    let n = 0;
    for (const [scope, rt] of this.byScope) {
      if (rt.agent_id !== agentId) continue;
      this.byScope.delete(scope);
      n++;
    }
    if (n) this.persist();
    return n;
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(`${this.path}.tmp`, JSON.stringify(Object.fromEntries(this.byScope), null, 2));
      renameSync(`${this.path}.tmp`, this.path);
    } catch {
      // best effort
    }
  }
}

/**
 * What the mod knows of one conversation from the daemon's chats: its agent, title, last message, and the settings that
 * belong to the chat rather than the agent.
 */
export interface LocalConversationInfo {
  agentId: string | null;
  title: string | null;
  lastMessageAt: string | null;
  archived: boolean;
  /** The conversation's own model, when it was switched away from the agent's. */
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  /** The chat's permission mode (glossary.md); on an ACP agent, the agent's own mode (plan 020, KD10). */
  mode: string;
  /** The person's labels on the chat (plan 022). */
  labels: string[];
  /** The person's one line on what the chat is for (plan 047); null when none. */
  purpose: string | null;
  /** A suggestion saved as a draft waits in the chat's message box (plan 047). */
  hasDraft: boolean;
  /** The folder the chat works in; null when it has none of its own. */
  cwd: string | null;
}

/** One conversation in the daemon's chat list, with whether it is archived or hidden. */
export interface LocalConversationRow {
  conversationId: string;
  agentId: string;
  archived: boolean;
  hidden: boolean;
  lastMessageAt: string | null;
}

/**
 * The desks of chats this Mac only keeps hidden (one it let go to another Mac, a background pass's): left out of the
 * lists even when a canvas or a saved layout here still names them (plan 023). A scope a visible chat also has stays.
 */
export function hiddenScopes(rows: ReadonlyArray<Pick<LocalConversationRow, "conversationId" | "agentId" | "hidden">>): Set<Scope> {
  const out = new Set(rows.filter((r) => r.hidden).map((r) => scopeFor(r.conversationId, r.agentId)));
  for (const r of rows) if (!r.hidden) out.delete(scopeFor(r.conversationId, r.agentId));
  return out;
}

/** The agent's display name from its record, if present. */
export function lookupLocalAgentName(agentId: string, backendDir = defaultBackendDir()): string | null {
  try {
    const a = JSON.parse(readFileSync(join(backendDir, "agents", `${backendName(agentId)}.json`), "utf8")) as { name?: string };
    return typeof a.name === "string" && a.name.trim() ? a.name.trim() : null;
  } catch {
    return null;
  }
}

/** Agents with a memory folder are the person's own; helper agents have none of their own. */
export function agentHasMemory(agentId: string, backendDir = defaultBackendDir()): boolean {
  return existsSync(join(backendDir, "memfs", agentId));
}

/** How many rows a chat opens with; scrolling past the oldest asks for this many more (history_get's `limit`). */
export const HISTORY_PAGE = 400;
/** The most a page may ask for: about a month of a busy chat, and a few MB over the phone's link. */
export const HISTORY_MAX = 20_000;
