import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Scope } from "../packages/core/src/desk-core.ts";
import { backendName, conversationDirName, scopeFor } from "../packages/core/src/desk-core.ts";
import { extractHarnessEvents, stripHarnessMarkup, toolLabel } from "../packages/core/src/harness.ts";
import type { Runtime } from "./app-server.ts";

/**
 * Desk registry: which agent + conversation a desk (scope) belongs to. The
 * scope is a sanitized conversation id, so this is how we get back to the real
 * ids the app-server needs. Learned from events and commands; persisted.
 */
export class DeskRegistry {
  private byScope = new Map<Scope, Runtime>();
  private readonly path: string;
  private readonly backendDir: string;

  constructor(path: string, backendDir = join(homedir(), ".letta", "lc-local-backend")) {
    this.path = path;
    this.backendDir = backendDir;
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
    const agent_id = agentId ?? this.byScope.get(scopeFor(conversationId))?.agent_id ?? lookupLocalAgentId(conversationId);
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
   * a conversation id whose owner the local backend records.
   */
  get(scope: Scope): Runtime | undefined {
    const known = this.byScope.get(scope);
    if (known) return known;
    if (scope === "shared") return undefined;
    let rt: Runtime | null = null;
    if (scope.startsWith("default-")) rt = { agent_id: scope.slice("default-".length), conversation_id: "default" };
    else {
      const agent_id = lookupLocalAgentId(scope, this.backendDir);
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
    for (const [scope, rt] of this.byScope) if (rt.agent_id === agentId) (this.byScope.delete(scope), n++);
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
}

/** The agent's display name from the local backend, if present. */
export function lookupLocalAgentName(agentId: string, backendDir = join(homedir(), ".letta", "lc-local-backend")): string | null {
  try {
    const a = JSON.parse(readFileSync(join(backendDir, "agents", `${backendName(agentId)}.json`), "utf8")) as { name?: string };
    return typeof a.name === "string" && a.name.trim() ? a.name.trim() : null;
  } catch {
    return null;
  }
}

/** Title and recency for a conversation from the local backend, if present. */
export function lookupLocalConversation(conversationId: string, agentId?: string | null, backendDir = join(homedir(), ".letta", "lc-local-backend")): LocalConversationInfo | null {
  try {
    const dir = join(backendDir, "conversations", conversationDirName(conversationId, agentId));
    const p = join(dir, "conversation.json");
    if (!existsSync(p)) return null;
    const c = JSON.parse(readFileSync(p, "utf8")) as { agent_id?: string; summary?: string | null; last_message_at?: string | null; archived?: boolean; model?: string | null };
    const agent = typeof c.agent_id === "string" ? c.agent_id : null;
    // An agent's main chat has no summary; call it by the agent's name.
    const fallback = conversationId === "default" && agent ? `${lookupLocalAgentName(agent, backendDir) ?? "agent"} · main chat` : null;
    return {
      agentId: agent,
      title: typeof c.summary === "string" && c.summary.trim() ? c.summary.trim() : fallback,
      lastMessageAt: typeof c.last_message_at === "string" ? c.last_message_at : null,
      archived: c.archived === true,
      model: typeof c.model === "string" && c.model ? c.model : null,
    };
  } catch {
    return null;
  }
}

/**
 * Local-backend fallback: conversations live in
 * ~/.letta/lc-local-backend/conversations/<base64("conversation:"+id)>/conversation.json
 * with an agent_id field. Lets a tab attach before any turn has told us the agent.
 */
export interface LocalConversationRow {
  conversationId: string;
  agentId: string;
  archived: boolean;
  hidden: boolean;
  lastMessageAt: string | null;
}

/**
 * Every conversation the local backend has, so the desks list is complete: a conversation that
 * never ran a turn while loki was up, and has no widgets, still deserves a row in the tree.
 */
export function listLocalConversations(backendDir = join(homedir(), ".letta", "lc-local-backend")): LocalConversationRow[] {
  const root = join(backendDir, "conversations");
  if (!existsSync(root)) return [];
  const out: LocalConversationRow[] = [];
  for (const name of readdirSync(root)) {
    try {
      const c = JSON.parse(readFileSync(join(root, name, "conversation.json"), "utf8")) as { id?: string; agent_id?: string; archived?: boolean; hidden?: boolean; last_message_at?: string | null };
      if (typeof c.id !== "string" || typeof c.agent_id !== "string") continue;
      out.push({ conversationId: c.id, agentId: c.agent_id, archived: c.archived === true, hidden: c.hidden === true, lastMessageAt: typeof c.last_message_at === "string" ? c.last_message_at : null });
    } catch {
      // not a conversation dir
    }
  }
  return out;
}

/** Agents with a memory filesystem are the user's own; the rest are one-off subagents the app-server hides. */
export function agentHasMemory(agentId: string, backendDir = join(homedir(), ".letta", "lc-local-backend")): boolean {
  return existsSync(join(backendDir, "memfs", agentId));
}

export function lookupLocalAgentId(conversationId: string, backendDir = join(homedir(), ".letta", "lc-local-backend")): string | null {
  if (conversationId === "default") return null; // ambiguous without the agent
  try {
    const dir = join(backendDir, "conversations", conversationDirName(conversationId));
    const p = join(dir, "conversation.json");
    if (!existsSync(p)) return null;
    const c = JSON.parse(readFileSync(p, "utf8")) as { agent_id?: string };
    return typeof c.agent_id === "string" ? c.agent_id : null;
  } catch {
    return null;
  }
}


export interface LocalTranscriptMessage {
  role: "user" | "assistant" | "tool" | "event";
  text: string;
  summary?: string | null;
  detail?: string | null;
}

/**
 * The conversation's full text transcript from the local backend log
 * (`messages.jsonl`). Unlike the app-server's message list, this survives
 * compaction, so a tab opened late still sees the whole conversation.
 * Tool calls become one-line markers, harness notices (background task
 * results, compaction) become event rows; tool results and thinking are
 * skipped. Only the last `limit` rows are returned, oldest first.
 */
export function readLocalTranscript(
  conversationId: string,
  agentId?: string | null,
  limit = 400,
  backendDir = join(homedir(), ".letta", "lc-local-backend"),
): LocalTranscriptMessage[] {
  const path = join(backendDir, "conversations", conversationDirName(conversationId, agentId), "messages.jsonl");
  if (!existsSync(path)) return [];
  const out: LocalTranscriptMessage[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) out.push(...transcriptRows(line));
  return out.length > limit ? out.slice(out.length - limit) : out;
}

/**
 * The transcript from line `fromLine` of the log on (a cursor the recall worker keeps per conversation),
 * and the line count to continue from. Same rows as readLocalTranscript.
 */
export function readLocalTranscriptSince(
  conversationId: string,
  agentId: string | null | undefined,
  fromLine: number,
  backendDir = join(homedir(), ".letta", "lc-local-backend"),
): { rows: LocalTranscriptMessage[]; lines: number } {
  const path = join(backendDir, "conversations", conversationDirName(conversationId, agentId), "messages.jsonl");
  if (!existsSync(path)) return { rows: [], lines: 0 };
  const all = readFileSync(path, "utf8").split("\n");
  const lines = all[all.length - 1] === "" ? all.length - 1 : all.length; // the trailing newline is not a line
  const rows: LocalTranscriptMessage[] = [];
  for (const line of all.slice(Math.max(0, fromLine), lines)) rows.push(...transcriptRows(line));
  return { rows, lines };
}

/** One log line → its transcript rows: user and assistant text, harness notices as events, tool calls as markers. */
function transcriptRows(line: string): LocalTranscriptMessage[] {
  if (!line.trim()) return [];
  let entry: { type?: string; message?: { role?: string; content?: unknown } };
  try {
    entry = JSON.parse(line) as typeof entry;
  } catch {
    return [];
  }
  if (entry.type !== "message" || !entry.message) return [];
  const role = entry.message.role;
  if (role !== "user" && role !== "assistant") return [];
  const out: LocalTranscriptMessage[] = [];
  const raw = textParts(entry.message.content);
  if (role === "user") {
    for (const ev of extractHarnessEvents(raw)) out.push({ role: "event", text: ev.text, summary: ev.summary, detail: ev.detail });
  }
  const text = (role === "user" ? stripHarnessMarkup(raw) : raw).trim();
  if (text) out.push({ role, text });
  if (role === "assistant") for (const t of toolCalls(entry.message.content)) out.push({ role: "tool", text: t });
  return out;
}

function toolCalls(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const part of content) {
    if (typeof part === "object" && part !== null && (part as { type?: string }).type === "toolCall") {
      const p = part as { name?: string; arguments?: unknown };
      if (p.name) out.push(toolLabel(p.name, p.arguments));
    }
  }
  return out;
}

function textParts(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const type = (part as { type?: string }).type;
    if (type === "text" && typeof (part as { text?: unknown }).text === "string") out += (out ? "\n" : "") + (part as { text: string }).text;
    else if (type === "image") out += (out ? "\n" : "") + "[image]";
  }
  return out;
}

/** What the inbox decides on without the app-server: who spoke last, and the assistant's last words. */
export interface LocalDigest {
  lastRole: "user" | "assistant" | null;
  lastAssistantText: string | null;
}

/** One open conversation as the inbox lists it: the record from disk plus its digest. */
export interface InboxRow extends LocalDigest {
  id: string;
  agentId: string;
  agentName: string | null;
  title: string | null;
  lastMessageAt: string | null;
  archived: false;
}

const DIGEST_TAIL_BYTES = 256 * 1024;
const DIGEST_TEXT_LIMIT = 700;

/**
 * The tail of a conversation's local log, read as the inbox reads it: the last human or assistant
 * message with text decides `lastRole` (harness markup in a user message does not count as the user
 * speaking), and the assistant's last text is kept for the card. Only the end of the file is read,
 * so a long main chat costs the same as a short one.
 */
export function digestLocalConversation(conversationId: string, agentId?: string | null, backendDir = join(homedir(), ".letta", "lc-local-backend")): LocalDigest {
  const path = join(backendDir, "conversations", conversationDirName(conversationId, agentId), "messages.jsonl");
  const none: LocalDigest = { lastRole: null, lastAssistantText: null };
  let tail: string;
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - DIGEST_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buf, 0, buf.length, start);
    } finally {
      closeSync(fd);
    }
    tail = buf.toString("utf8");
  } catch {
    return none;
  }
  const lines = tail.split("\n");
  if (lines.length && tail.length === DIGEST_TAIL_BYTES) lines.shift(); // a line cut in half at the window's edge
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    let entry: { type?: string; message?: { role?: string; content?: unknown } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue;
    const role = entry.message.role;
    if (role === "user") {
      if (stripHarnessMarkup(textParts(entry.message.content)).trim()) return { lastRole: "user", lastAssistantText: null };
    } else if (role === "assistant") {
      const text = textParts(entry.message.content).trim();
      if (text) return { lastRole: "assistant", lastAssistantText: text.slice(-DIGEST_TEXT_LIMIT) };
    }
  }
  return none;
}
