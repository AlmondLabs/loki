import type { Context } from "@earendil-works/chord";
import type { ConversationId } from "@earendil-works/pi-durable";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { backendName } from "../core/desk-core.ts";
import { ChatIndex } from "./kernel/index.ts";
import type { StoreManager } from "./kernel/stores.ts";
import { commitMemoryFiles, memoryRoot } from "./memory.ts";
import { listAgents, writeRecord } from "./store/agents.ts";
import { isRecord } from "./tool-kinds.ts";

/**
 * The agents' records, memory and chats' settings in the shapes loki writes now, once on each Mac (plan 045): what
 * the import from Letta brought over as Letta wrote it. Noted in `state/migrations.json` (`agents`), so a start after
 * the first reads nothing. A chat's saved entries are the store's own migration's (daemon/store-migration.ts).
 */
export const AGENTS_VERSION = 1;

/** Letta's names for ChatGPT's sign-in provider; pi-ai's is openai-codex. */
const PROVIDER_ALIASES: Readonly<Record<string, string>> = { "chatgpt-plus-pro": "openai-codex", chatgpt_oauth: "openai-codex" };

/**
 * A model handle as pi-ai can run it. A handle whose provider pi-ai knows is kept; otherwise the first part that names
 * a known provider starts it (Letta wrote some as `chatgpt-plus-pro/chatgpt-plus-pro/openai-codex/<model>`), or
 * Letta's name for ChatGPT's provider is translated. Anything else stays as it is, and fails with its own name.
 */
export function piHandle(handle: string, known: (provider: string) => boolean): string {
  const parts = handle.split("/");
  if (parts.length < 2 || known(parts[0])) return handle;
  for (let i = 1; i < parts.length - 1; i++) if (known(parts[i])) return parts.slice(i).join("/");
  const alias = PROVIDER_ALIASES[parts[0]];
  return alias && known(alias) ? [alias, ...parts.slice(1)].join("/") : handle;
}

/** `.letta/loki` as a whole path segment pair: loki's folder before it moved to `~/.loki`. */
const OLD_ROOT = /(?<![\w.-])\.letta\/loki(?![\w.-])/g;
const isEffort = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/**
 * An agent's `model_settings` with its effort as `reasoning_effort` alone, the one key loki reads: Letta kept it as
 * `effort`, `reasoning.reasoning_effort` or a disabled `thinking`, beside its `provider_type`. Null when nothing changes.
 */
export function settingsNow(settings: Record<string, unknown>): Record<string, unknown> | null {
  const { effort, reasoning, thinking, provider_type: _type, ...rest } = settings;
  const nested = isRecord(reasoning) ? reasoning.reasoning_effort : undefined;
  const off = isRecord(thinking) && thinking.type === "disabled" ? "none" : undefined;
  const level = [rest.reasoning_effort, effort, nested, off].find(isEffort);
  const now = { ...rest, ...(level ? { reasoning_effort: level } : {}) };
  return JSON.stringify(now) === JSON.stringify(settings) ? null : now;
}

/** What the migration needs: the agents' folder and stores, which providers pi-ai knows, and Learn's old file. */
export interface AgentMigrationDeps {
  backendDir: string;
  stores: StoreManager;
  known: (provider: string) => boolean;
  /** Learn's `worker.json` from before the background passes, which names its chats brought from Letta. */
  learnWorkerFile: string;
  /** `state/migrations.json`. */
  stateFile: string;
  /** Where a helper agent's record from Letta goes, out of the agents' folder. */
  backupDir: string;
  context: Context;
  report: (line: string) => void;
}

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/** Run the migration unless this Mac has; true when it ran. */
export async function migrateAgents(d: AgentMigrationDeps): Promise<boolean> {
  const state = readJson(d.stateFile);
  const done = isRecord(state) ? state : {};
  if (typeof done.agents === "number" && done.agents >= AGENTS_VERSION) return false;
  migrateRecords(d);
  for (const id of listAgents(d.backendDir)) {
    await migrateMemory(d, id);
    await migrateChats(d, id);
  }
  mkdirSync(join(d.stateFile, ".."), { recursive: true });
  writeFileSync(d.stateFile, `${JSON.stringify({ ...done, agents: AGENTS_VERSION }, null, 2)}\n`);
  return true;
}

/** Each record's model by pi-ai's name and its effort under loki's key; Letta's helper agents' records moved out. */
function migrateRecords(d: AgentMigrationDeps): void {
  const dir = join(d.backendDir, "agents");
  const names = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")) : [];
  for (const name of names) {
    const record = readJson(join(dir, name));
    if (!isRecord(record) || typeof record.id !== "string") continue;
    const tags = Array.isArray(record.tags) ? record.tags : [];
    if (tags.some((t) => t === "role:subagent" || (typeof t === "string" && t.startsWith("role:subagent:")))) {
      mkdirSync(join(d.backupDir, "agents"), { recursive: true });
      renameSync(join(dir, name), join(d.backupDir, "agents", name));
      d.report(`${record.id}: a helper agent from Letta, its record moved to ${d.backupDir}`);
      continue;
    }
    const model = typeof record.model === "string" ? piHandle(record.model, d.known) : record.model;
    const settings = isRecord(record.model_settings) ? settingsNow(record.model_settings) : null;
    if (model === record.model && !settings) continue;
    writeRecord(d.backendDir, record.id, { ...record, model, ...(settings ? { model_settings: settings } : {}) });
    d.report(`${record.id}: its record now in loki's shape`);
  }
}

/** Every file in a memory repo but its git folder. */
function memoryFiles(root: string, dir = root, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) memoryFiles(root, full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** Memory files naming `~/.letta/loki` name `~/.loki`, committed as loki's. */
async function migrateMemory(d: AgentMigrationDeps, agentId: string): Promise<void> {
  const root = memoryRoot(d.backendDir, agentId);
  if (!existsSync(root)) return;
  const changed: string[] = [];
  for (const file of memoryFiles(root)) {
    if (!/\.(md|txt|json|ya?ml)$/i.test(file)) continue;
    const text = readFileSync(file, "utf8");
    const now = text.replace(OLD_ROOT, ".loki");
    if (now === text) continue;
    writeFileSync(file, now);
    changed.push(relative(root, file));
  }
  if (!changed.length) return;
  if (existsSync(join(root, ".git")))
    await commitMemoryFiles(root, changed, "Name ~/.loki, loki's folder, for ~/.letta/loki", { name: "loki", email: "loki@loki.local" });
  d.report(`${agentId}: ${changed.length} memory files now name ~/.loki`);
}

/** Learn's chats brought from Letta, by chat id: its writers' and its earlier hidden chats. */
function learnChats(file: string): Set<string> {
  const w = readJson(file);
  if (!isRecord(w)) return new Set();
  const ids = [w.writers, w.recallConversations].flatMap((m) => (isRecord(m) ? Object.values(m) : []));
  return new Set(ids.filter((v): v is string => typeof v === "string"));
}

/** Each chat on loki's engine runs on pi-ai's name for its model, in its folder under `~/.loki`; Learn's old ones hidden. */
async function migrateChats(d: AgentMigrationDeps, agentId: string): Promise<void> {
  if (!existsSync(join(d.backendDir, "agents", `${backendName(agentId)}.json`))) return;
  const store = await d.stores.get(agentId);
  const index = await store.harness.snapshot(ChatIndex, d.context);
  const learn = learnChats(d.learnWorkerFile);
  let moved = 0;
  // One chat at a time, on purpose: each may commit to the store, and one store's commits go in order.
  for (const [chatId, conversationId] of Object.entries(index?.chats ?? {})) {
    const info = await store.chatInfo(conversationId as ConversationId, d.context);
    if (info?.engine?.kind === "acp") continue;
    const conversation = await store.harness.conversation(conversationId as ConversationId, d.context);
    if (!conversation) continue;
    const settings = (await store.agentSettings(conversation.id, d.context)) as { model?: { provider?: string; modelId?: string }; cwd?: string } | undefined;
    const change: { model?: { provider: string; modelId: string }; cwd?: string } = {};
    const model = settings?.model;
    if (model?.provider && model.modelId && !d.known(model.provider)) {
      const handle = piHandle(`${model.provider}/${model.modelId}`, d.known);
      const slash = handle.indexOf("/");
      if (slash > 0 && handle.slice(0, slash) !== model.provider) change.model = { provider: handle.slice(0, slash), modelId: handle.slice(slash + 1) };
    }
    const cwd = settings?.cwd?.replace(OLD_ROOT, ".loki");
    if (cwd && cwd !== settings?.cwd) change.cwd = cwd;
    if (change.model || change.cwd) {
      await conversation.configure(change, d.context);
      moved++;
    }
    if (learn.has(chatId) && !info?.hidden) {
      await store.updateChat(chatId, { hidden: true }, d.context);
      moved++;
    }
  }
  if (moved) d.report(`${agentId}: ${moved} chats' model, folder or place in the list now as loki keeps them`);
}
