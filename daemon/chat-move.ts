import type { Context } from "@earendil-works/chord";
import type { ImportedEntry } from "./import/convert.ts";
import type { AgentStore } from "./kernel/index.ts";
import type { ScheduledTask } from "./schedule.ts";

/**
 * Moving one chat to the Mac it now belongs on (plan 023, U9, KTD11): the Mac it lived on copies it out, the Mac it
 * moves to writes it into its own store under the same loki id, and only once that is done does the first Mac hide its
 * copy and stop its schedules. The chat's whole log goes, as pi-durable's entries (re-minted, compactions relinked, as
 * the import from Letta writes them), with its title, folder, model, mode and labels, its schedules and its passes'
 * cursors. Usage totals stay on the Mac they were spent on.
 */

/** A chat as it travels between Macs. */
export interface MovedChat {
  agent_id: string;
  conversation_id: string;
  info: { title: string | null; archived: boolean; mode: string | null; labels: string[]; created_at: string };
  /** What the conversation ran with: its model and folder, when it had its own. */
  agent: { model?: { provider: string; modelId: string }; cwd?: string };
  entries: ImportedEntry[];
  schedules: ScheduledTask[];
  /** Where each background pass had read to (daemon/passes-state.ts), by job. */
  cursors: Record<string, number>;
}

/** A chat's log, its info and what it runs with, out of the store it lives in; null when there is no such chat. */
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

/** Write a moved chat into this Mac's store under its own id; false when a chat of that id is already here (a move tried again). */
export async function importChat(store: AgentStore, moved: MovedChat, context: Context): Promise<boolean> {
  if (await store.chat(moved.conversation_id, context)) return false;
  const conversation = await store.createChat(
    moved.conversation_id,
    { title: moved.info.title, createdAt: moved.info.created_at, ...(Object.keys(moved.agent).length ? { agent: moved.agent } : {}) },
    context,
  );
  await store.importEntries(conversation, moved.entries, context);
  await store.updateChat(
    moved.conversation_id,
    { archived: moved.info.archived, labels: moved.info.labels, ...(moved.info.mode ? { mode: moved.info.mode } : {}) },
    context,
  );
  return true;
}
