import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Scope } from "../core/desk-core.ts";
import { backendName, scopeFor } from "../core/desk-core.ts";
import { backendDir as defaultBackendDir } from "./agents.ts";
import type { PermissionMode } from "../daemon/approvals.ts";
import type { ReasoningEffort } from "../core/models.ts";

/** A chat by its agent and conversation ids, as the desk registry keeps it. */
export interface Runtime {
  agent_id: string;
  conversation_id: string;
}

export class DeskRegistry {
  private byScope = new Map<Scope, Runtime>();
  private readonly path: string;
  private readonly agentOf: (conversationId: string) => string | null;

  /** `agentOf` names the agent of a conversation it has not seen (the daemon's chats, mod/chat-source.ts). */
  constructor(path: string, agentOf: (conversationId: string) => string | null) {
    this.path = path;
    this.agentOf = agentOf;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, Runtime>;
      let rewritten = false;
      for (const [k, v] of Object.entries(parsed)) {
        if (!v?.agent_id || !v?.conversation_id) continue;
        // One scope per conversation: an older loki filed a main chat under the bare scope "default";
        // today it is `default-<agentId>`. Fold legacy keys onto the canonical one so no desk shows twice.
        const canonical = scopeFor(v.conversation_id, v.agent_id);
        if (k !== canonical) {
          rewritten = true;
          if (!this.byScope.has(canonical)) this.byScope.set(canonical, v);
          continue;
        }
        this.byScope.set(k, v);
      }
      if (rewritten) this.persist();
    } catch {
      // fresh
    }
  }

  /** Record a conversation; returns its scope. */
  remember(conversationId: string, agentId: string | null | undefined): Scope {
    const agent_id = agentId ?? this.byScope.get(scopeFor(conversationId))?.agent_id ?? this.agentOf(conversationId);
    const scope = scopeFor(conversationId, agent_id);
    const prev = this.byScope.get(scope);
    if (!agent_id) return scope;
    if (prev?.agent_id !== agent_id || prev.conversation_id !== conversationId) {
      this.byScope.set(scope, { agent_id, conversation_id: conversationId });
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
      const agent_id = this.agentOf(scope);
      if (agent_id) rt = { agent_id, conversation_id: scope };
    }
    if (!rt) return undefined;
    this.byScope.set(scope, rt);
    this.persist();
    return rt;
  }

  all(): Array<{ scope: Scope } & Runtime> {
    return [...this.byScope.entries()].map(([scope, rt]) => ({ scope, ...rt }));
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

export interface LocalConversationInfo {
  agentId: string | null;
  title: string | null;
  lastMessageAt: string | null;
  archived: boolean;
  /** The conversation's own model, when it was switched away from the agent's. */
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  /** The chat's permission mode (GLOSSARY.md). */
  mode: PermissionMode;
}

export interface LocalConversationRow {
  conversationId: string;
  agentId: string;
  archived: boolean;
  hidden: boolean;
  lastMessageAt: string | null;
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
