import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { scopeFor, type WidgetChange } from "../core/canvas-core.ts";
import { isWriterChat, learnTitle, type Lead } from "../core/learn/model.ts";
import type { Replies } from "../core/frames.ts";
import type { ChatBackend } from "./frames/chat.ts";
import type { TranscriptRow } from "../core/attention/transcript.ts";
import { log } from "./log.ts";
import type { LearnStore } from "./learn.ts";
import { paths } from "./paths.ts";
import { messageOf } from "../core/errors.ts";

export const REPLAY_CHARS = 4_000;
export const MAX_QUOTED_CARDS = 80;
export const MAX_OPEN_LEADS = 12;

export const ownsLearnChat = (conversationId: string): boolean => isWriterChat(conversationId);

export const isPassChat = (conversationId: string): boolean =>
  ownsLearnChat(conversationId) || conversationId.startsWith("reflection-") || conversationId.startsWith("doctor-");

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

const CALL_CHARS = 200;

const clip = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > CALL_CHARS ? `${line.slice(0, CALL_CHARS - 1)}…` : line;
};

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

export type StartLesson = (leadId: string) => Promise<Replies["learn_lesson"]>;
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
  store: LearnStore;
  widgetsDir?: string;
  expect?: (widgetId: string, change: WidgetChange) => void;
}
type CreateLessonChat = (agentId: string, title: string) => Promise<{ agentId: string; conversationId: string }>;

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
      log.error("recall:lesson-card-failed", { message: messageOf(err) });
    }
    const lesson = opts.store.startLesson(leadId, rt);
    log("recall:lesson-started", { lead: leadId, conversation: rt.conversationId });
    return { agent_id: lesson?.agent_id ?? rt.agentId, conversation_id: lesson?.conversation_id ?? rt.conversationId };
  };
}

export function startLessonViaChats(chats: ChatBackend, opts: LessonOpts): StartLesson {
  return startLessonWith((agentId, title) => chats.create(agentId, homedir(), title), opts);
}
