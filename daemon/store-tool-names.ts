import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RENAMED_TOOLS, SPLIT_TOOLS, isRecord, renameToolsIn } from "./tool-kinds.ts";
import { copyStore } from "./store-backup.ts";
import type { Context } from "@earendil-works/chord";
import type { ConversationId } from "@earendil-works/pi-durable";
import { ChatIndex, type AgentStore } from "./kernel/index.ts";

/**
 * Saved chats under loki's tools' names now (plan 044). A tool renamed keeps its calls in every chat that ever used
 * it, and the window, the question card and the model all read them; rather than every reader knowing every old name,
 * each store's calls and results are renamed once, when the store first opens on a loki that has this. A chat on an
 * ACP agent is left as it is: its steps carry the agent's own names (Claude Code's `Agent`, `Skill`…), not loki's.
 */

/** Every old name, as a saved call (`"name":"…"`) or result (`"toolName":"…"`) spells it, for the first pass's filter. */
const OLD_NAMES = [...Object.keys(RENAMED_TOOLS), ...Object.keys(SPLIT_TOOLS)];

/** What one store's renaming did. */
export interface ToolNamesReport {
  /** Entries rewritten. */
  entries: number;
  /** The whole store as it was, copied before the change; null when nothing was written. */
  backup: string | null;
}

/**
 * Rename the old tool names in the store at `file`, except in the conversations `skip` names (chats on an ACP agent):
 * the store is first copied whole into `backupDir`, then every changed entry is written in one transaction. pi-durable
 * may have the store open, unstarted: nothing it holds in memory names a tool.
 */
export function renameStoredTools(file: string, skip: ReadonlySet<number>, backupDir: string): ToolNamesReport {
  const db = new DatabaseSync(file);
  try {
    const like = OLD_NAMES.map(() => "record LIKE ?").join(" OR ");
    const rows = db
      .prepare(
        `SELECT id, conversation_id, record FROM entries WHERE json_extract(record, '$.kind') IN ('pi.assistant', 'pi.tool-result') AND (${like}) ORDER BY id`,
      )
      .all(...OLD_NAMES.map((n) => `%"${n}"%`)) as Array<{ id: number; conversation_id: number; record: string }>;
    const calls = new Map<string, string>();
    const changed: Array<{ id: number; record: string }> = [];
    for (const row of rows) {
      if (skip.has(row.conversation_id)) continue;
      const record: unknown = JSON.parse(row.record);
      if (!isRecord(record) || !Array.isArray(record.model)) continue;
      if (renameToolsIn(record.model, calls)) changed.push({ id: row.id, record: JSON.stringify(record) });
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

/** The file beside the stores that lists the ones already renamed, so each is renamed once. */
const doneFile = (file: string) => join(dirname(file), "tool-names.json");

/** Whether the store at `file` has had its tools renamed; a new store is, once it has first opened. */
export function toolNamesDone(file: string): boolean {
  try {
    const done: unknown = JSON.parse(readFileSync(doneFile(file), "utf8"));
    return Array.isArray(done) && done.includes(basename(file));
  } catch {
    return false;
  }
}

/** Note the store at `file` as renamed. */
export function markToolNamesDone(file: string): void {
  let done: string[] = [];
  try {
    const read: unknown = JSON.parse(readFileSync(doneFile(file), "utf8"));
    if (Array.isArray(read)) done = read.filter((x): x is string => typeof x === "string");
  } catch {
    // None yet.
  }
  if (!done.includes(basename(file))) writeFileSync(doneFile(file), `${JSON.stringify([...done, basename(file)], null, 2)}\n`);
}

/** The conversations of the store's chats on an ACP agent, which keep the agent's own tool names. */
export async function acpConversations(store: AgentStore, context: Context): Promise<Set<number>> {
  const index = await store.harness.snapshot(ChatIndex, context);
  const out = new Set<number>();
  for (const conversationId of Object.values(index?.chats ?? {})) {
    const info = await store.chatInfo(conversationId as ConversationId, context);
    if (info?.engine?.kind === "acp") out.add(conversationId);
  }
  return out;
}
