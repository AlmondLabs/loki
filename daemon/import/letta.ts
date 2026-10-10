import type { Context } from "@earendil-works/chord";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isPermissionMode } from "../approvals.ts";
import { modelRef } from "../chat-backend.ts";
import type { StoreManager } from "../kernel/stores.ts";
import { writeRecord } from "../store/agents.ts";
import type { ScheduledTask } from "../schedule.ts";
import { lettaLogCwd, lettaLogEntries } from "./convert.ts";

/**
 * The one-time import from Letta (plan 017, U14): the person's agents (those with a memory folder; helper agents
 * left out), their memory repos with git history, and every conversation of theirs, each a chat under its Letta id,
 * so widgets, Inbox marks, pins and board stamps keyed by those ids still find it. Keys move into the keychain,
 * permission modes and folders onto the chats, schedules into loki's file, and Learn's cursors into the converted
 * chats. It refuses while Letta runs, never writes to Letta's files, and can run again: a second run imports only
 * what is missing and never touches a chat the daemon has written since.
 */

export type ImportPaths = {
  /** Letta's home folder (`~/.letta`). */
  letta: string;
  /** The daemon's agents, in Letta's backend layout. */
  backendDir: string;
  /** What the import has finished, so a second run picks up where it stopped. */
  doneFile: string;
  schedulesFile: string;
  pinsFile: string;
  /** Learn's worker state (mod/recall.ts), whose cursors count Letta log lines until converted. */
  recallWorkerFile: string;
};

export type ImportReport = {
  agents: string[];
  chats: number;
  /** Chats already converted, or written by the daemon since, left as they are. */
  kept: number;
  credentials: string[];
  schedules: number;
  notes: string[];
};

type Done = { agents: string[]; chats: string[] };

const readJson = <T>(file: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
};

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2) + "\n");
  renameSync(`${file}.tmp`, file);
}

/** Letta's key for a chat in its settings maps (permissionModeMap, cwdMap). */
export function permissionModeKey(agentId: string, conversationId: string): string {
  return conversationId === "default" ? `agent:${agentId}::conversation:default` : `conversation:${conversationId}`;
}

/** A Letta process that is running now, by its command line, or null: the desktop app or the `letta` CLI. */
export function runningLetta(commands: () => string[] = psCommands): string | null {
  for (const line of commands()) {
    if (/--loki-daemon\b/.test(line)) continue;
    const program = line.trim().split(/\s+/)[0] ?? "";
    if (/(^|\/)letta[^/]*$/i.test(program) || /letta-code|\/bin\/letta(\s|$)/i.test(line)) return line.trim().slice(0, 120);
  }
  return null;
}

function psCommands(): string[] {
  if (process.platform === "win32") {
    try {
      return execFileSync("tasklist", ["/fo", "csv", "/nh"], { encoding: "utf8" }).split("\n").map((l) => l.split(",")[0]?.replace(/"/g, "") ?? "");
    } catch {
      return [];
    }
  }
  try {
    return execFileSync("/bin/ps", ["-axo", "command="], { encoding: "utf8" }).split("\n");
  } catch {
    return [];
  }
}

/**
 * Letta's provider entries as pi-ai credentials, under pi-ai's provider ids. Anthropic's subscription sign-in is
 * left out (pi-ai presents itself as Claude Code for it, daemon/providers.ts), as is a provider pi-ai does not know.
 */
export function lettaCredentials(authFile: string, known: ReadonlySet<string>): { credentials: Array<[string, Credential]>; skipped: string[] } {
  type Entry = { id?: string; provider_type?: string; auth?: { type?: string; key?: string; access?: string; refresh?: string; expires?: number; [k: string]: unknown } };
  const providers = readJson<{ providers?: Record<string, Entry> }>(authFile, {}).providers ?? {};
  const credentials: Array<[string, Credential]> = [];
  const skipped: string[] = [];
  for (const [id, entry] of Object.entries(providers)) {
    const auth = entry.auth ?? {};
    const type = entry.provider_type ?? id;
    const piId = type === "chatgpt_oauth" ? "openai-codex" : known.has(type) ? type : known.has(id) ? id : null;
    if (auth.type === "oauth" && (piId === "anthropic" || /anthropic|claude/i.test(type))) {
      skipped.push(`${id}: Anthropic's subscription sign-in is not carried over; connect Anthropic with an API key`);
      continue;
    }
    if (!piId) {
      skipped.push(`${id}: no provider of that name here`);
      continue;
    }
    if (auth.type === "api" && auth.key) credentials.push([piId, { type: "api_key", key: auth.key }]);
    else if (auth.type === "oauth" && auth.access && auth.refresh) {
      const { type: _t, ...rest } = auth;
      credentials.push([piId, { ...rest, type: "oauth", access: auth.access, refresh: auth.refresh, expires: Number(auth.expires ?? 0) }]);
    } else skipped.push(`${id}: no key or sign-in to carry over`);
  }
  return { credentials, skipped };
}

/** Letta's scheduled tasks, for the agents imported, in loki's shape (daemon/schedule.ts). */
export function lettaSchedules(cronsFile: string, agents: ReadonlySet<string>): ScheduledTask[] {
  type LettaTask = Partial<ScheduledTask> & { status?: string; last_fired_at?: string | null };
  const tasks = readJson<{ tasks?: LettaTask[] }>(cronsFile, {}).tasks ?? [];
  return tasks
    .filter((t) => t.status === "active" && t.agent_id && agents.has(t.agent_id) && t.id && t.cron && t.prompt)
    .map((t) => ({
      id: t.id!,
      agent_id: t.agent_id!,
      conversation_id: t.conversation_id ?? "default",
      name: t.name ?? t.id!,
      description: t.description ?? null,
      cron: t.cron!,
      timezone: t.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      recurring: t.recurring !== false,
      prompt: t.prompt!,
      status: "active",
      created_at: t.created_at ?? new Date().toISOString(),
      last_fired_at: t.last_fired_at ?? null,
      fire_count: t.fire_count ?? 0,
    }));
}

/** The person's agents in Letta's backend: a record, a memory folder, and not a helper. */
function lettaAgents(backend: string): Array<{ id: string; record: Record<string, unknown> }> {
  const out: Array<{ id: string; record: Record<string, unknown> }> = [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const file of existsSync(join(backend, "agents")) ? readdirSync(join(backend, "agents")) : []) {
    if (!file.endsWith(".json")) continue;
    const record = readJson<Record<string, unknown> | null>(join(backend, "agents", file), null);
    if (record && typeof record.id === "string") byId.set(record.id, record);
  }
  for (const id of existsSync(join(backend, "memfs")) ? readdirSync(join(backend, "memfs")) : []) {
    const record = byId.get(id);
    const tags = Array.isArray(record?.tags) ? (record.tags as unknown[]) : [];
    if (!record || !existsSync(join(backend, "memfs", id, "memory"))) continue;
    if (tags.some((t) => typeof t === "string" && (t === "role:subagent" || t.startsWith("role:subagent:")))) continue;
    out.push({ id, record });
  }
  return out;
}

type LettaConversation = { id: string; agent_id: string; summary?: string | null; archived?: boolean; hidden?: boolean; created_at?: string; model?: string };

export async function importFromLetta(deps: {
  paths: ImportPaths;
  stores: StoreManager;
  credentials: CredentialStore;
  knownProviders: ReadonlySet<string>;
  context: Context;
  running?: () => string | null;
  /** Told each chat's entry count once it is imported: its history is not new to reflection (daemon/reflection.ts). */
  imported?: (agentId: string, chatId: string, entries: number) => void;
}): Promise<ImportReport> {
  const { paths, context } = deps;
  const running = (deps.running ?? runningLetta)();
  if (running) throw new Error(`Letta is running (${running}); quit it, then import`);
  const backend = join(paths.letta, "lc-local-backend");
  if (!existsSync(backend)) throw new Error(`no Letta backend at ${backend}`);
  const done = readJson<Done>(paths.doneFile, { agents: [], chats: [] });
  const report: ImportReport = { agents: [], chats: 0, kept: 0, credentials: [], schedules: 0, notes: [] };

  // Agents and their memory.
  const agents = lettaAgents(backend);
  const ids = new Set(agents.map((a) => a.id));
  for (const { id, record } of agents) {
    if (!existsSync(join(paths.backendDir, "memfs", id, "memory"))) cpSync(join(backend, "memfs", id, "memory"), join(paths.backendDir, "memfs", id, "memory"), { recursive: true, verbatimSymlinks: true });
    writeRecord(paths.backendDir, id, record);
    await (await deps.stores.get(id)).setAgent({ id, name: String(record.name ?? id) }, context);
    if (!done.agents.includes(id)) done.agents.push(id);
    report.agents.push(String(record.name ?? id));
  }
  writeJson(paths.doneFile, done);

  // Settings kept per chat in Letta's files.
  const remote = readJson<{ permissionModeMap?: Record<string, { mode?: string }>; cwdMap?: Record<string, string> }>(join(paths.letta, "remote-settings.json"), {});
  const desktopCwd = readJson<{ cwdMap?: Record<string, string> }>(join(paths.letta, "desktop-cwd-map.json"), {}).cwdMap ?? {};
  const worker = readJson<{ cursors?: Record<string, number>; leadCursors?: Record<string, number> } & Record<string, unknown>>(paths.recallWorkerFile, {});
  let cursorsMoved = false;

  // Conversations, each into its agent's store under its Letta id.
  for (const dir of existsSync(join(backend, "conversations")) ? readdirSync(join(backend, "conversations")) : []) {
    const base = join(backend, "conversations", dir);
    const record = readJson<LettaConversation | null>(join(base, "conversation.json"), null);
    if (!record || !ids.has(record.agent_id)) continue;
    const key = `${record.agent_id}/${record.id}`;
    if (done.chats.includes(key)) {
      report.kept++;
      continue;
    }
    const store = await deps.stores.get(record.agent_id);
    const existing = await store.chat(record.id, context);
    if (existing && (await store.entries(existing, context)).length > 0) {
      report.kept++;
      report.notes.push(`${key}: the daemon has written to it already; left as it is`);
      continue;
    }
    const text = existsSync(join(base, "messages.jsonl")) ? readFileSync(join(base, "messages.jsonl"), "utf8") : "";
    const settingsKey = permissionModeKey(record.agent_id, record.id);
    const cwd = desktopCwd[settingsKey] ?? remote.cwdMap?.[settingsKey] ?? lettaLogCwd(text);
    const agentRecord = agents.find((a) => a.id === record.agent_id)!.record;
    const model = modelRef(record.model ?? (typeof agentRecord.model === "string" ? agentRecord.model : ""));
    const chat = existing ?? (await store.createChat(record.id, { title: record.summary?.trim() || null, hidden: record.hidden === true, createdAt: record.created_at, agent: { ...(model ? { model } : {}), ...(cwd ? { cwd } : {}) } }, context));
    const mode = remote.permissionModeMap?.[settingsKey]?.mode;
    await store.updateChat(record.id, { archived: record.archived === true, ...(isPermissionMode(mode) ? { mode } : {}) }, context);
    const entries = lettaLogEntries(text);
    const byLine = await store.importEntries(chat, entries, context);

    // Learn's cursors counted the log's lines; on the daemon they count the chat's entries.
    // A cursor of N lines resumes after the last entry made from those lines (or before the first imported one).
    const written = (await store.entries(chat, context)).map((e) => e.id);
    const first = Math.min(...byLine.values());
    const toEntries = (lines: number) => {
      const read = [...byLine].filter(([line]) => line < lines).map(([, id]) => id);
      const upTo = read.length ? Math.max(...read) : first - 1;
      return written.filter((id) => id <= upTo).length;
    };
    for (const field of ["cursors", "leadCursors"] as const) {
      const at = worker[field]?.[key];
      if (typeof at === "number") {
        worker[field]![key] = toEntries(at);
        cursorsMoved = true;
      }
    }
    deps.imported?.(record.agent_id, record.id, written.length);
    done.chats.push(key);
    writeJson(paths.doneFile, done);
    report.chats++;
  }
  if (cursorsMoved) writeJson(paths.recallWorkerFile, worker);

  // Keys and sign-ins.
  const { credentials, skipped } = lettaCredentials(join(backend, "providers", "auth.json"), deps.knownProviders);
  for (const [providerId, credential] of credentials) {
    await deps.credentials.modify(providerId, async () => credential);
    report.credentials.push(providerId);
  }
  report.notes.push(...skipped);

  // Scheduled tasks, by id, once.
  const schedules = readJson<{ tasks?: ScheduledTask[] }>(paths.schedulesFile, {}).tasks ?? [];
  const fresh = lettaSchedules(join(paths.letta, "crons.json"), ids).filter((t) => !schedules.some((s) => s.id === t.id));
  if (fresh.length) writeJson(paths.schedulesFile, { version: 1, tasks: [...schedules, ...fresh] });
  report.schedules = fresh.length;

  // Pinned chats, the first time.
  const lettaPins = join(paths.letta, "pinned-conversations.json");
  if (!existsSync(paths.pinsFile) && existsSync(lettaPins)) writeJson(paths.pinsFile, readJson(lettaPins, {}));

  return report;
}
