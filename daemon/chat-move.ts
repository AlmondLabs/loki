import type { Context } from "@earendil-works/chord";
import { existsSync } from "node:fs";
import { contentText, messageFiles, movedMark } from "../core/harness.ts";
import type { SavedDraft, Suggestion } from "../core/frame-types.ts";
import { BRANCH_KIND, type AgentStore, type ImportedEntry } from "./kernel/index.ts";
import type { ScheduledTask } from "./schedule.ts";

export interface MovedChat {
  agent_id: string;
  conversation_id: string;
  /** `placed`: it goes where the person put it, and the hand-over to its agent's home leaves it there (addendum A2). */
  info: {
    title: string | null;
    archived: boolean;
    mode: string | null;
    labels: string[];
    created_at: string;
    placed?: boolean;
    /** Absent from a Mac that predates them (plan 049). */
    purpose?: string | null;
    draft?: SavedDraft | null;
    suggestions?: Suggestion[];
  };
  /** What the conversation ran with: its model and folder, when it had its own. */
  agent: { model?: { provider: string; modelId: string }; cwd?: string };
  entries: ImportedEntry[];
  schedules: ScheduledTask[];
  /** Where each background pass had read to (daemon/passes-state.ts), by job. */
  cursors: Record<string, number>;
}

export async function exportChat(
  store: AgentStore,
  agentId: string,
  chatId: string,
  extras: { schedules: ScheduledTask[]; cursors: Record<string, number> },
  context: Context,
): Promise<MovedChat | null> {
  const chat = await store.chat(chatId, context);
  if (!chat) return null;
  const info = await store.chatInfo(chat.id, context);
  const settings = (await store.agentSettings(chat.id, context)) as { model?: { provider?: unknown; modelId?: unknown }; cwd?: unknown } | undefined;
  const entries = await store.entries(chat, context);
  const model =
    typeof settings?.model?.provider === "string" && typeof settings.model.modelId === "string"
      ? { provider: settings.model.provider, modelId: settings.model.modelId }
      : undefined;
  return {
    agent_id: agentId,
    conversation_id: chatId,
    info: {
      title: info?.title ?? null,
      archived: info?.archived === true,
      mode: typeof info?.mode === "string" ? info.mode : null,
      labels: info?.labels ?? [],
      created_at: info?.createdAt ?? new Date().toISOString(),
      ...(info?.placed ? { placed: true } : {}),
      ...(info?.purpose ? { purpose: info.purpose } : {}),
      ...(info?.draft ? { draft: info.draft } : {}),
      ...(info?.suggestions?.length ? { suggestions: info.suggestions } : {}),
    },
    agent: { ...(model ? { model } : {}), ...(typeof settings?.cwd === "string" ? { cwd: settings.cwd } : {}) },
    entries: entries.map((e, line) => ({
      sourceId: String(e.id),
      line,
      kind: e.kind as ImportedEntry["kind"],
      ...(e.model ? { model: e.model as unknown as NonNullable<ImportedEntry["model"]> } : {}),
      ...(e.data ? { data: e.data as unknown as NonNullable<ImportedEntry["data"]> } : {}),
      ...(e.head === undefined ? {} : { headSourceId: String(e.head) }),
    })),
    schedules: extras.schedules,
    cursors: extras.cursors,
  };
}

export interface MoveNames {
  from: string;
  to: string;
}

export async function importChat(store: AgentStore, moved: MovedChat, context: Context, names?: MoveNames, now = Date.now()): Promise<boolean> {
  const here = await store.chat(moved.conversation_id, context);
  if (here) {
    if ((await store.chatInfo(here.id, context))?.hidden !== true) return false;
    await store.retireChat(moved.conversation_id, context);
  }
  const conversation = await store.createChat(
    moved.conversation_id,
    { title: moved.info.title, createdAt: moved.info.created_at, ...(Object.keys(moved.agent).length ? { agent: moved.agent } : {}) },
    context,
  );
  try {
    await store.importEntries(conversation, moved.entries, context);
    await store.updateChat(
      moved.conversation_id,
      {
        archived: moved.info.archived,
        labels: moved.info.labels,
        ...(moved.info.mode ? { mode: moved.info.mode } : {}),
        ...(moved.info.placed ? { placed: true } : {}),
        ...(moved.info.purpose ? { purpose: moved.info.purpose } : {}),
        ...(moved.info.draft ? { draft: moved.info.draft } : {}),
        ...(moved.info.suggestions?.length ? { suggestions: moved.info.suggestions } : {}),
        ...(names ? { moved: { ...names, files_left: filesLeft(moved) } } : {}),
      },
      context,
    );
    if (names)
      await store.importEntries(
        conversation,
        [{ sourceId: "moved", line: 0, kind: BRANCH_KIND, data: { message: { role: "user", content: movedMark(names.from, names.to), timestamp: now } } }],
        context,
      );
  } catch (error) {
    await store.retireChat(moved.conversation_id, context).catch(() => false);
    throw error;
  }
  return true;
}

function filesLeft(moved: MovedChat): number {
  const paths = new Set<string>();
  for (const e of moved.entries) for (const m of e.model ?? []) if (m.role === "user") for (const f of messageFiles(contentText(m.content))) paths.add(f.path);
  return [...paths].filter((p) => !existsSync(p)).length;
}
