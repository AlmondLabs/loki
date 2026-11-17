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
import { readJson } from "../mod/json-file.ts";

export const AGENTS_VERSION = 1;

const PROVIDER_ALIASES: Readonly<Record<string, string>> = { "chatgpt-plus-pro": "openai-codex", chatgpt_oauth: "openai-codex" };

export function piHandle(handle: string, known: (provider: string) => boolean): string {
  const parts = handle.split("/");
  if (parts.length < 2 || known(parts[0])) return handle;
  for (let i = 1; i < parts.length - 1; i++) if (known(parts[i])) return parts.slice(i).join("/");
  const alias = PROVIDER_ALIASES[parts[0]];
  return alias && known(alias) ? [alias, ...parts.slice(1)].join("/") : handle;
}

const OLD_ROOT = /(?<![\w.-])\.letta\/loki(?![\w.-])/g;
const isEffort = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export function settingsNow(settings: Record<string, unknown>): Record<string, unknown> | null {
  const { effort, reasoning, thinking, provider_type: _type, ...rest } = settings;
  const nested = isRecord(reasoning) ? reasoning.reasoning_effort : undefined;
  const off = isRecord(thinking) && thinking.type === "disabled" ? "none" : undefined;
  const level = [rest.reasoning_effort, effort, nested, off].find(isEffort);
  const now = { ...rest, ...(level ? { reasoning_effort: level } : {}) };
  return JSON.stringify(now) === JSON.stringify(settings) ? null : now;
}

export interface AgentMigrationDeps {
  backendDir: string;
  stores: StoreManager;
  known: (provider: string) => boolean;
  learnWorkerFile: string;
  stateFile: string;
  backupDir: string;
  context: Context;
  report: (line: string) => void;
}

export async function migrateAgents(d: AgentMigrationDeps): Promise<boolean> {
  const state = readJson(d.stateFile);
  const done = isRecord(state) ? state : {};
  if (typeof done.agents === "number" && done.agents >= AGENTS_VERSION) return false;
  migrateRecords(d);
  await Promise.all(listAgents(d.backendDir).map(async (id) => Promise.all([migrateMemory(d, id), migrateChats(d, id)])));
  mkdirSync(join(d.stateFile, ".."), { recursive: true });
  writeFileSync(d.stateFile, `${JSON.stringify({ ...done, agents: AGENTS_VERSION }, null, 2)}\n`);
  return true;
}

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

function memoryFiles(root: string, dir = root, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) memoryFiles(root, full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

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

function learnChats(file: string): Set<string> {
  const w = readJson(file);
  if (!isRecord(w)) return new Set();
  const ids = [w.writers, w.recallConversations].flatMap((m) => (isRecord(m) ? Object.values(m) : []));
  return new Set(ids.filter((v): v is string => typeof v === "string"));
}

async function migrateChats(d: AgentMigrationDeps, agentId: string): Promise<void> {
  if (!existsSync(join(d.backendDir, "agents", `${backendName(agentId)}.json`))) return;
  const store = await d.stores.get(agentId);
  const index = await store.harness.snapshot(ChatIndex, d.context);
  const learn = learnChats(d.learnWorkerFile);
  const writes = await Promise.all(
    Object.entries(index?.chats ?? {}).map(async ([chatId, conversationId]): Promise<Array<() => Promise<unknown>>> => {
      const info = await store.chatInfo(conversationId as ConversationId, d.context);
      if (info?.engine?.kind === "acp") return [];
      const conversation = await store.harness.conversation(conversationId as ConversationId, d.context);
      if (!conversation) return [];
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
      return [
        ...(change.model || change.cwd ? [() => conversation.configure(change, d.context)] : []),
        ...(learn.has(chatId) && !info?.hidden ? [() => store.updateChat(chatId, { hidden: true }, d.context)] : []),
      ];
    }),
  );
  const moved = writes.flat();
  await Promise.all(moved.map((write) => write()));
  if (moved.length) d.report(`${agentId}: ${moved.length} chats' model, folder or place in the list now as loki keeps them`);
}
