import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { scopeFor, type WidgetChange } from "../core/desk-core.ts";
import { isWriterChat, learnTitle, type Lead } from "../core/recall/model.ts";
import type { ChatBackend } from "./frames/chat.ts";
import type { TranscriptRow } from "../core/attention/transcript.ts";
import { log } from "./log.ts";
import { RecallStore } from "./recall.ts";
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
 * The cards worth quoting to the model: those whose front, back or tags share a word of five letters or more
 * with the slices (tags of three or more), most shared words first, MAX_QUOTED_CARDS at most. The rest are on
 * disk for the model to grep — the prompt tells it where — so the quoted list stops growing with the deck.
 */
export function overlappingCards<T extends { front: string; back: string; tags: string[] }>(cards: T[], texts: string[], cap = MAX_QUOTED_CARDS): T[] {
  const words = new Set(texts.join(" ").toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []);
  const scored = cards
    .map((c) => {
      const own = new Set([...(`${c.front} ${c.back}`.toLowerCase().match(/[a-z][a-z0-9_-]{4,}/g) ?? []), ...c.tags.map((t) => t.toLowerCase()).filter((t) => t.length >= 3)]);
      let hits = 0;
      for (const w of own) if (words.has(w)) hits += 1;
      return { c, hits };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits);
  return scored.slice(0, cap).map((x) => x.c);
}

/** "you: …" / "<agent>: …" lines; tool markers and harness notices are left out. */
export function formatTranscript(rows: TranscriptRow[], agentName: string | null): string {
  const who = agentName ?? "agent";
  return rows
    .filter((r) => r.role === "user" || r.role === "assistant")
    .map((r) => `${r.role === "user" ? "you" : who}: ${r.text.trim()}`)
    .join("\n");
}

/**
 * Start a lesson from a lead: a new conversation `[Learn] · <title>` for the lead's agent in the home
 * directory, the brief sent as the person's first message, the lead recorded as a lesson. The socket
 * waits for the harness's first word back (or two seconds) so the turn is under way before it closes.
 */
export type StartLesson = (leadId: string) => Promise<{ agentId: string; conversationId: string }>;
/**
 * The first thing on a lesson's desk: an info card with the lead, so the desk is furnished before the agent says a
 * word. The agent's outline joins it once the brief lands (the app sends the brief over its own live socket, the way
 * the board's dispatch does — a message fired from a socket that closes right after never reaches the agent).
 */
export function lessonCard(lead: Lead): { type: "info-card"; title: string; data: { lines: string[] } } {
  const who = lead.source.agentName ?? "the agent";
  const where = lead.source.title ? `it came up in "${lead.source.title}" with ${who}` : `it came up in a conversation with ${who}`;
  return {
    type: "info-card",
    title: lead.title,
    data: { lines: [lead.depth === "primer" ? "a primer — one sitting" : "a course — a few sittings", where, lead.why, `${who} lays the lesson out here; the chat opens with the brief`] },
  };
}

type LessonOpts = { store: RecallStore; widgetsDir?: string; expect?: (widgetId: string, change: WidgetChange) => void };
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
    if (!lead.source.agentId) throw new Error("the lead names no agent");
    const rt = await create(lead.source.agentId, learnTitle(lead.title));
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
    return { agentId: lesson?.agentId ?? rt.agentId, conversationId: lesson?.conversationId ?? rt.conversationId };
  };
}

/** Learn on loki's daemon: the lesson's chat is made in process (mod/frames/chat.ts). */
export function startLessonViaChats(chats: ChatBackend, opts: LessonOpts): StartLesson {
  return startLessonWith((agentId, title) => chats.create(agentId, homedir(), title), opts);
}

