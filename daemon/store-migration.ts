import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RENAMED_TOOLS, SPLIT_TOOLS, isRecord, renameToolsIn } from "./tool-kinds.ts";
import { copyStore } from "./store-backup.ts";
import type { Context } from "@earendil-works/chord";
import type { ConversationId } from "@earendil-works/pi-durable";
import { ChatIndex, type AgentStore } from "./kernel/index.ts";

/**
 * A store's saved entries in the shapes loki writes now, rewritten once when the store first opens on a loki that has
 * this, so nothing that reads history knows an older shape (plans 044 and 045). A chat on an ACP agent is left as it
 * is: its steps carry the agent's own names (Claude Code's `Agent`, `Skill`…), not loki's.
 *
 * Version 1 renamed loki's old tool names. Version 2 rewrites what chats imported from Letta still carried: the
 * Codex-style `cmd` argument, Letta's notes in user messages, its background-task notices, `multiSelect` in questions
 * and paths under `~/.letta/loki`. Every step is idempotent, so a store at any older version runs them all.
 */
export const STORE_VERSION = 2;

/** Letta's notes inside a user message: kept for the model as loki's own reminder, which the window hides. */
const LETTA_NOTES: ReadonlyArray<[RegExp, (block: string) => string]> = [
  [/<system-alert>([\s\S]*?)<\/system-alert>/g, (inner) => `<system-reminder>${inner}</system-reminder>`],
  [/<channel-notification[^>]*>([\s\S]*?)<\/channel-notification>/g, (inner) => `<system-reminder>${inner}</system-reminder>`],
];
/** Letta's compaction note, a line of JSON on its own. */
const SYSTEM_ALERT = /^(\s*)(\{"type":\s*"system_alert"[\s\S]*?\})(\s*)$/gm;
/** Letta's pointer to its own copy of a conversation, a path into its folder. */
const TRANSCRIPT_LINE = /^\s*Full transcript available at: \S+\s*$/gm;
/** Letta's background notice names the command (`Background command "X" completed`); loki's summary is the command. */
const LETTA_NOTICE = /<summary>\w+ command "(.+?)" \w+(?: \([^)]*\))?<\/summary>/g;
/** `.letta/loki` as a whole path segment pair: loki's folder before it moved to `~/.loki`. */
const OLD_ROOT = /(?<![\w.-])\.letta\/loki(?![\w.-])/g;

/** A user message's text as loki writes it: Letta's notes as reminders, its transcript pointer gone, notices bare. */
export function withoutLettaText(text: string): string {
  let out = text;
  for (const [pattern, wrap] of LETTA_NOTES) out = out.replace(pattern, (_m, inner: string) => wrap(inner));
  return out
    .replace(SYSTEM_ALERT, (_m, before: string, alert: string, after: string) => `${before}<system-reminder>${alert}</system-reminder>${after}`)
    .replace(TRANSCRIPT_LINE, "")
    .replace(LETTA_NOTICE, (_m, command: string) => `<summary>${command}</summary>`);
}

/** The text parts of a user message, rewritten in place; true when any changed. */
function rewriteUser(m: Record<string, unknown>): boolean {
  if (typeof m.content === "string") {
    const now = withoutLettaText(m.content);
    if (now === m.content) return false;
    m.content = now;
    return true;
  }
  if (!Array.isArray(m.content)) return false;
  let changed = false;
  for (const part of m.content as unknown[]) {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") continue;
    const now = withoutLettaText(part.text);
    if (now !== part.text) {
      part.text = now;
      changed = true;
    }
  }
  return changed;
}

/** A tool call's arguments as loki reads them: the shell command as `command`, a question's `multi_select`. */
function rewriteCall(part: Record<string, unknown>): boolean {
  const args = part.arguments;
  if (!isRecord(args)) return false;
  let changed = false;
  if (typeof args.cmd === "string" && args.command === undefined) {
    const { cmd, ...rest } = args;
    part.arguments = { command: cmd, ...rest };
    changed = true;
  }
  const questions = isRecord(part.arguments) ? part.arguments.questions : undefined;
  if (Array.isArray(questions))
    for (const q of questions as unknown[]) {
      if (!isRecord(q) || q.multiSelect === undefined) continue;
      if (q.multi_select === undefined) q.multi_select = q.multiSelect;
      delete q.multiSelect;
      changed = true;
    }
  return changed;
}

/**
 * One saved entry's messages in the shapes loki writes now, in place: tool names (filling `calls`, so a result follows
 * its call), call arguments, user messages' text, and a branch entry's message. True when anything changed.
 */
export function migrateMessages(record: Record<string, unknown>, calls: Map<string, string>): boolean {
  const messages = [...(Array.isArray(record.model) ? (record.model as unknown[]) : [])];
  if (isRecord(record.data) && isRecord(record.data.message)) messages.push(record.data.message);
  let changed = renameToolsIn(messages, calls);
  for (const m of messages) {
    if (!isRecord(m)) continue;
    if (m.role === "user") changed = rewriteUser(m) || changed;
    else if (m.role === "assistant" && Array.isArray(m.content))
      for (const part of m.content as unknown[]) if (isRecord(part) && part.type === "toolCall") changed = rewriteCall(part) || changed;
  }
  return changed;
}

/** What a saved entry may hold that needs rewriting, for the first pass's filter: an old tool name or a Letta shape. */
const NEEDLES = [
  ...[...Object.keys(RENAMED_TOOLS), ...Object.keys(SPLIT_TOOLS)].map((n) => `"${n}"`),
  '"cmd"',
  "multiSelect",
  "system-alert",
  "system_alert",
  "channel-notification",
  "Full transcript available at:",
  ' command \\"',
  ".letta/loki",
];

/** What one store's migration did. */
export interface StoreMigrationReport {
  /** Entries rewritten. */
  entries: number;
  /** The whole store as it was, copied before the change; null when nothing was written. */
  backup: string | null;
}

/**
 * Rewrite the store at `file`'s saved entries in the shapes loki writes now, except in the conversations `skip` names
 * (chats on an ACP agent): the store is first copied whole into `backupDir`, then every changed entry is written in one
 * transaction. pi-durable may have the store open, unstarted: nothing it holds in memory is an entry.
 */
export function migrateStoredEntries(file: string, skip: ReadonlySet<number>, backupDir: string): StoreMigrationReport {
  const db = new DatabaseSync(file);
  try {
    const like = NEEDLES.map(() => "record LIKE ?").join(" OR ");
    const rows = db
      .prepare(
        `SELECT id, conversation_id, record FROM entries WHERE json_extract(record, '$.kind') IN ('pi.assistant', 'pi.tool-result', 'pi.user', 'loki.branch') AND (${like}) ORDER BY id`,
      )
      .all(...NEEDLES.map((n) => `%${n}%`)) as Array<{ id: number; conversation_id: number; record: string }>;
    const calls = new Map<string, string>();
    const changed: Array<{ id: number; record: string }> = [];
    for (const row of rows) {
      if (skip.has(row.conversation_id)) continue;
      const record: unknown = JSON.parse(row.record);
      if (!isRecord(record)) continue;
      const rewritten = migrateMessages(record, calls);
      const before = rewritten ? JSON.stringify(record) : row.record;
      const after = before.replace(OLD_ROOT, ".loki");
      if (after !== row.record) changed.push({ id: row.id, record: after });
    }
    if (changed.length === 0) return { entries: 0, backup: null };
    const backup = copyStore(db, file, backupDir);
    const update = db.prepare("UPDATE entries SET record = ? WHERE id = ?");
    db.exec("BEGIN");
    try {
      for (const c of changed) update.run(c.record, c.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { entries: changed.length, backup };
  } finally {
    db.close();
  }
}

/** The file beside the stores that holds each one's version, so each step runs once. */
const versionsFile = (file: string) => join(dirname(file), "migrations.json");

const readVersions = (file: string): Record<string, number> => {
  try {
    const read: unknown = JSON.parse(readFileSync(versionsFile(file), "utf8"));
    if (!isRecord(read)) return {};
    return Object.fromEntries(Object.entries(read).filter((e): e is [string, number] => typeof e[1] === "number"));
  } catch {
    return {};
  }
};

/** The version the store at `file` is at: 0 until it has first opened on a loki with migrations. */
export const storeVersion = (file: string): number => readVersions(file)[basename(file)] ?? 0;

/** Note the store at `file` as at STORE_VERSION. Plan 044's `tool-names.json`, which this replaces, goes. */
export function markStoreVersion(file: string): void {
  writeFileSync(versionsFile(file), `${JSON.stringify({ ...readVersions(file), [basename(file)]: STORE_VERSION }, null, 2)}\n`);
  rmSync(join(dirname(file), "tool-names.json"), { force: true });
}

/** The conversations of the store's chats on an ACP agent, which keep the agent's own names. */
export async function acpConversations(store: AgentStore, context: Context): Promise<Set<number>> {
  const index = await store.harness.snapshot(ChatIndex, context);
  const out = new Set<number>();
  // One at a time: every read is the same SQLite store's, which node:sqlite answers synchronously; together saves nothing.
  for (const conversationId of Object.values(index?.chats ?? {})) {
    const info = await store.chatInfo(conversationId as ConversationId, context);
    if (info?.engine?.kind === "acp") out.add(conversationId);
  }
  return out;
}
