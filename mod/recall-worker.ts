import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { scopeFor, type WidgetChange } from "../core/desk-core.ts";
import { isWriterChat, learnTitle, type Lead } from "../core/recall/model.ts";
import type { Replies } from "../core/frames.ts";
import type { ChatBackend } from "./frames/chat.ts";
import type { TranscriptRow } from "../core/attention/transcript.ts";
import { log } from "./log.ts";
import type { RecallStore } from "./recall.ts";
import { paths } from "./paths.ts";

/**
 * Learn's pieces the daemon's Learn pass (daemon/learn.ts) and lessons share: which hidden chats are Learn's own,
 * the transcript as the model reads it, the existing cards worth quoting, and starting a lesson from a lead. Cards
 * are written by the Learn pass alone; the person meets them only in the Learn section.
 */
/** A replay slice — the tail of the conversation a failing card came from — is this long at most. */
export const REPLAY_CHARS = 4_000;
/** Existing cards quoted in the prompt: the ones whose wording overlaps the slices, this many at most. */
export const MAX_QUOTED_CARDS = 80;
/** Open learning leads the pile holds at most; past this the writer is not asked for more until some are started or dismissed. */
export const MAX_OPEN_LEADS = 12;

/** True for Learn's own hidden chats (the daemon's writer chats, and the ones the import brought from Letta), which must never become desks or inbox cards. */
export function ownsRecallChat(store: RecallStore, conversationId: string): boolean {
  return isWriterChat(conversationId) || store.legacyChats().includes(conversationId);
}

/**
 * A background pass's own chat, which is never a desk, an inbox card or a chat in the list: Learn's (above) or
 * reflection's (`reflection-<agent>`, daemon/memory.ts isReflectionChat). What they did shows as cards and memory
 * changes instead.
 */
export function isPassChat(store: RecallStore, conversationId: string): boolean {
  return passChats(store)(conversationId);
}

/** The rule of isPassChat with Learn's old chats read once, for checking a whole list of chats (plan 040). */
export function passChats(store: RecallStore): (conversationId: string) => boolean {
  const legacy = new Set(store.legacyChats());
  return (id) => isWriterChat(id) || legacy.has(id) || id.startsWith("reflection-") || id.startsWith("doctor-");
}

/**
 * The cards worth quoting to the model: those whose front, back or tags share a word of five letters or more
 * with the slices (tags of three or more), most shared words first, MAX_QUOTED_CARDS at most. The rest are on
 * disk for the model to grep — the prompt tells it where — so the quoted list stops growing with the deck.
 */
export function overlappingCards<T extends { front: string; back: string; tags: string[] }>(cards: T[], texts: string[], cap = MAX_QUOTED_CARDS): T[] {
  const words = new Set(
    texts
      .join(" ")
      .toLowerCase()
      .match(/[a-z][a-z0-9_-]{2,}/g) ?? [],
  );
  const scored = cards
    .map((c) => {
      const own = new Set([
        ...(`${c.front} ${c.back}`.toLowerCase().match(/[a-z][a-z0-9_-]{4,}/g) ?? []),
        ...c.tags.map((t) => t.toLowerCase()).filter((t) => t.length >= 3),
      ]);
      let hits = 0;
      for (const w of own) if (words.has(w)) hits += 1;
      return { c, hits };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits);
  return scored.slice(0, cap).map((x) => x.c);
}

/** How much of a failed call's input and error a transcript shows (plan 036). */
const CALL_CHARS = 200;

const clip = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > CALL_CHARS ? `${line.slice(0, CALL_CHARS - 1)}…` : line;
};

/**
 * "you: …" / "<agent>: …" lines; harness notices are left out, and so are tool calls unless `failedCalls`. With it
 * (reflection, plan 036), a call that failed is a line where it happened, `[failed bash: <input> → <error>]`, and the
 * next call of the same tool that worked follows as `[then bash worked: <input>]`, so the fix is there beside the
 * mistake. Calls that worked otherwise stay out.
 */
export function formatTranscript(rows: TranscriptRow[], agentName: string | null, { failedCalls = false }: { failedCalls?: boolean } = {}): string {
  const who = agentName ?? "agent";
  const failing = new Set<string>();
  const lines: string[] = [];
  for (const r of rows) {
    if (r.role === "user" || r.role === "assistant") lines.push(`${r.role === "user" ? "you" : who}: ${r.text.trim()}`);
    else if (failedCalls && r.role === "tool" && r.tool?.output !== undefined) {
      const { name, input = "" } = r.tool;
      if (r.tool.failed) {
        failing.add(name);
        lines.push(`[failed ${name}: ${clip(input)} → ${clip(r.tool.error ?? "")}]`);
      } else if (failing.delete(name)) lines.push(`[then ${name} worked: ${clip(input)}]`);
    }
  }
  return lines.join("\n");
}

/**
 * Start a lesson from a lead: a new conversation `[Learn] · <title>` for the lead's agent in the home
 * directory, the brief sent as the person's first message, the lead recorded as a lesson. The socket
 * waits for the harness's first word back (or two seconds) so the turn is under way before it closes.
 */
export type StartLesson = (leadId: string) => Promise<Replies["recall_lesson"]>;
/**
 * The first thing on a lesson's desk: an info card with the lead, so the desk is furnished before the agent says a
 * word. The agent's outline joins it once the brief lands (the app sends the brief over its own live socket, the way
 * the task list's dispatch does — a message fired from a socket that closes right after never reaches the agent).
 */
export function lessonCard(lead: Lead): { type: "info-card"; title: string; data: { lines: string[] } } {
  const who = lead.source.agent_name ?? "the agent";
  const where = lead.source.title ? `it came up in "${lead.source.title}" with ${who}` : `it came up in a conversation with ${who}`;
  return {
    type: "info-card",
    title: lead.title,
    data: {
      lines: [
        lead.depth === "primer" ? "a primer — one sitting" : "a course — a few sittings",
        where,
        lead.why,
        `${who} lays the lesson out here; the chat opens with the brief`,
      ],
    },
  };
}

interface LessonOpts {
  store: RecallStore;
  widgetsDir?: string;
  expect?: (widgetId: string, change: WidgetChange) => void;
}
/** Make a lesson's chat for an agent, titled `[Learn] · <lead>`, in the home folder. */
type CreateLessonChat = (agentId: string, title: string) => Promise<{ agentId: string; conversationId: string }>;

/**
 * Start a lesson: its chat made by `create` in the home folder, the info card written on its desk, the lead recorded as
 * a lesson. opts.expect: told just before the lesson card is written, so the desk's widget log reads it as loki's
 * (mod/widget-log.ts).
 */
function startLessonWith(create: CreateLessonChat, opts: LessonOpts): StartLesson {
  return async (leadId) => {
    const lead = opts.store.lead(leadId);
    if (!lead) throw new Error("no such lead");
    if (!lead.source.agent_id) throw new Error("the lead names no agent");
    const rt = await create(lead.source.agent_id, learnTitle(lead.title));
    const scope = scopeFor(rt.conversationId, rt.agentId);
    const dir = join(opts.widgetsDir ?? paths.widgets, scope);
    try {
      mkdirSync(dir, { recursive: true });
      opts.expect?.(`${scope}/lesson`, existsSync(join(dir, "lesson.json")) ? "changed" : "added");
      writeFileSync(join(dir, "lesson.json"), JSON.stringify(lessonCard(lead), null, 2) + "\n");
    } catch (err) {
      log("recall:lesson-card-failed", { message: err instanceof Error ? err.message : String(err) }); // the desk starts bare; the lesson still starts
    }
    const lesson = opts.store.startLesson(leadId, rt);
    log("recall:lesson-started", { lead: leadId, conversation: rt.conversationId });
    return { agent_id: lesson?.agent_id ?? rt.agentId, conversation_id: lesson?.conversation_id ?? rt.conversationId };
  };
}

/** Learn on loki's daemon: the lesson's chat is made in process (mod/frames/chat.ts). */
export function startLessonViaChats(chats: ChatBackend, opts: LessonOpts): StartLesson {
  return startLessonWith((agentId, title) => chats.create(agentId, homedir(), title), opts);
}
