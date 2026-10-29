import type { Context } from "@earendil-works/chord";
import { existsSync } from "node:fs";
import { contentText, messageFiles, movedMark } from "../core/harness.ts";
import type { SavedDraft, Suggestion } from "../core/frame-types.ts";
import { BRANCH_KIND, type AgentStore, type ImportedEntry } from "./kernel/index.ts";
import type { ScheduledTask } from "./schedule.ts";

/**
 * Moving one chat to the Mac it now belongs on (plan 023, U9, KTD11): the Mac it lived on copies it out, the Mac it
 * moves to writes it into its own store under the same loki id, and only once that is done does the first Mac hide its
 * copy and stop its schedules. The chat's whole log goes, as pi-durable's entries (re-minted, compactions relinked),
 * with its title, folder, model, mode, labels, purpose line, saved draft and suggestions, its schedules and its passes'
 * cursors. Usage totals stay on the Mac they were spent on.
 */

/** A chat as it travels between Macs. */
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

/** The Macs a chat moved between, by name, for its mark and the agent's note (addendum A5). */
export interface MoveNames {
  from: string;
  to: string;
}

/**
 * Write a moved chat into this Mac's store under its own id; false when a chat of that id is already here (a move tried
 * again). The hidden copy left by an earlier move away is set aside first, so a chat can come back (addendum A4). With
 * `names`, the thread is marked where it moved and the agent is told with the next message (addendum A5).
 */
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
  // A chat written in part is set aside, hidden, as a chat that moved away is: left under its id, a retry of the move
  // would find it "already here" and the other Mac would let go of the only whole copy.
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

/** How many files the chat's messages carried that are not on this Mac: they stayed where they were attached. */
function filesLeft(moved: MovedChat): number {
  const paths = new Set<string>();
  for (const e of moved.entries) for (const m of e.model ?? []) if (m.role === "user") for (const f of messageFiles(contentText(m.content))) paths.add(f.path);
  return [...paths].filter((p) => !existsSync(p)).length;
}
