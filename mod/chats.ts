import { existsSync, readFileSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Scope } from "../core/chat-scope.ts";
import { MAIN_CHAT_ID, mainChatAgent, scopeFor, SHARED_SCOPE } from "../core/chat-scope.ts";
import { backendDir as defaultBackendDir } from "./agents.ts";
import type { ReasoningEffort } from "../core/models.ts";
import { writeJsonAtomic } from "./json-file.ts";

export interface Runtime {
  agent_id: string;
  conversation_id: string;
}

export class ChatRegistry {
  private byScope = new Map<Scope, Runtime>();
  private readonly path: string;
  private readonly agentOf: (conversationId: string) => string | null;

  constructor(path: string, agentOf: (conversationId: string) => string | null) {
    this.path = path;
    this.agentOf = agentOf;
    if (!existsSync(path) && basename(path) === "chats.json") {
      const legacy = join(dirname(path), "desks.json");
      if (existsSync(legacy)) {
        try {
          renameSync(legacy, path);
        } catch {}
      }
    }
    try {
      const readPath = existsSync(path) ? path : basename(path) === "chats.json" ? join(dirname(path), "desks.json") : path;
      const parsed = JSON.parse(readFileSync(readPath, "utf8")) as Record<string, Partial<Runtime> | null>;
      let rewritten = false;
      for (const [k, v] of Object.entries(parsed)) {
        if (!v?.agent_id || !v.conversation_id) continue;
        const rt: Runtime = { ...v, agent_id: v.agent_id, conversation_id: v.conversation_id };
        const canonical = scopeFor(rt.conversation_id, rt.agent_id);
        if (k !== canonical) {
          rewritten = true;
          if (!this.byScope.has(canonical)) this.byScope.set(canonical, rt);
          continue;
        }
        this.byScope.set(k, rt);
      }
      if (rewritten) this.persist();
    } catch {}
  }

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

  get(scope: Scope): Runtime | undefined {
    const known = this.byScope.get(scope);
    if (known) return known;
    if (scope === SHARED_SCOPE) return undefined;
    let rt: Runtime | null = null;
    const mainAgent = mainChatAgent(scope);
    if (mainAgent !== null) rt = { agent_id: mainAgent, conversation_id: MAIN_CHAT_ID };
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
      writeJsonAtomic(this.path, Object.fromEntries(this.byScope), { pretty: true });
    } catch {}
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
  mode: string;
  labels: string[];
  purpose: string | null;
  hasDraft: boolean;
  draftText?: string | null;
  /** The folder the chat works in; null when it has none of its own. */
  cwd: string | null;
}

export interface LocalConversationRow {
  conversationId: string;
  agentId: string;
  archived: boolean;
  hidden: boolean;
  lastMessageAt: string | null;
}

export function hiddenScopes(rows: ReadonlyArray<Pick<LocalConversationRow, "conversationId" | "agentId" | "hidden">>): Set<Scope> {
  const out = new Set(rows.filter((r) => r.hidden).map((r) => scopeFor(r.conversationId, r.agentId)));
  for (const r of rows) if (!r.hidden) out.delete(scopeFor(r.conversationId, r.agentId));
  return out;
}

export function agentHasMemory(agentId: string, backendDir = defaultBackendDir()): boolean {
  return existsSync(join(backendDir, "memfs", agentId));
}

export const HISTORY_PAGE = 100;
export const HISTORY_MAX = 20_000;
