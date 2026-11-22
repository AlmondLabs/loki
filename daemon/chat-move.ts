import type { Context } from "@earendil-works/chord";
import type { Conversation, EntryRecord } from "@earendil-works/pi-durable";
import { existsSync } from "node:fs";
import { advisorChatId, type AdvisorConsult } from "../core/advisor.ts";
import { contentText, messageFiles, movedMark } from "../core/harness.ts";
import type { SavedDraft, Suggestion } from "../core/frame-types.ts";
import { isReasoningEffort, type ReasoningEffort } from "../core/models.ts";
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
    /** Absent when the chat has none. */
    purpose?: string | null;
    draft?: SavedDraft | null;
    suggestions?: Suggestion[];
    /** The consults the chat sent its advisor (core/advisor.ts); queued ones run on the Mac it lands on. Absent, none. */
    advisor_consults?: AdvisorConsult[];
  };
  /** What the conversation ran with: its model and folder, when it had its own. */
  agent: { model?: { provider: string; modelId: string }; cwd?: string };
  entries: ImportedEntry[];
  schedules: ScheduledTask[];
  /** Where each background pass had read to (daemon/passes-state.ts), by job. */
  cursors: Record<string, number>;
  /** The chat's advisor chat, when it has one. Absent, none. */
  advisor?: MovedAdvisor;
}

/**
 * An advisor chat moving with its chat (daemon/advisor.ts): its history, its model and effort, and its folder. The
 * Mac it lands on gives it the advisor's tools, prompt and mode again, which the record does not carry.
 */
export interface MovedAdvisor {
  archived: boolean;
  created_at: string;
  agent: { model?: { provider: string; modelId: string }; effort?: ReasoningEffort; cwd?: string };
  entries: ImportedEntry[];
}

async function settingsOf(store: AgentStore, chat: Conversation, context: Context) {
  // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- tsgolint 7.0.2005 calls this a no-op, but tsc needs it: agentSettings returns object, which has no fields to read.
  const settings = (await store.agentSettings(chat.id, context)) as
    | { model?: { provider?: unknown; modelId?: unknown }; cwd?: unknown; thinkingLevel?: unknown }
    | undefined;
  const model =
    typeof settings?.model?.provider === "string" && typeof settings.model.modelId === "string"
      ? { provider: settings.model.provider, modelId: settings.model.modelId }
      : undefined;
  const level = settings?.thinkingLevel === "off" ? "none" : settings?.thinkingLevel;
  return {
    model,
    cwd: typeof settings?.cwd === "string" ? settings.cwd : undefined,
    effort: typeof level === "string" && isReasoningEffort(level) ? level : undefined,
  };
}

const movedEntries = (entries: readonly EntryRecord[]): ImportedEntry[] =>
  entries.map((e, line) => ({
    sourceId: String(e.id),
    line,
    kind: e.kind as ImportedEntry["kind"],
    ...(e.model ? { model: e.model as unknown as NonNullable<ImportedEntry["model"]> } : {}),
    ...(e.data ? { data: e.data as unknown as NonNullable<ImportedEntry["data"]> } : {}),
    ...(e.head === undefined ? {} : { headSourceId: String(e.head) }),
  }));

async function exportAdvisor(store: AgentStore, chatId: string, context: Context): Promise<MovedAdvisor | null> {
  const advisor = await store.chat(advisorChatId(chatId), context);
  if (!advisor) return null;
  const info = await store.chatInfo(advisor.id, context);
  const { model, effort, cwd } = await settingsOf(store, advisor, context);
  return {
    archived: info?.archived === true,
    created_at: info?.createdAt ?? new Date().toISOString(),
    agent: { ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(cwd ? { cwd } : {}) },
    entries: movedEntries(await store.entries(advisor, context)),
  };
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
  const { model, cwd } = await settingsOf(store, chat, context);
  const entries = await store.entries(chat, context);
  const advisor = await exportAdvisor(store, chatId, context);
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
      ...(info?.advisor_consults?.length ? { advisor_consults: info.advisor_consults } : {}),
    },
    agent: { ...(model ? { model } : {}), ...(cwd ? { cwd } : {}) },
    entries: movedEntries(entries),
    schedules: extras.schedules,
    cursors: extras.cursors,
    ...(advisor ? { advisor } : {}),
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
    const consults = moved.info.advisor_consults;
    if (consults?.length) await store.updateConsults(moved.conversation_id, () => consults, context);
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
