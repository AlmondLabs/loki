/**
 * Letta's harness injects machinery into transcripts as ordinary messages:
 * system reminders, background-task notifications, compaction notes, and
 * loki's own desk-activity block. Both halves of loki need to recognise them:
 * the mod for the chat mirror, the browser for the Catch Up thread.
 */

import type { FileRef, ToolStep } from "./attention/transcript.ts";

export function stripHarnessMarkup(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<system-alert>[\s\S]*?<\/system-alert>/g, "")
    .replace(/<lo[ck]i-desk[^>]*>[\s\S]*?<\/lo[ck]i-desk>/g, "") // the mod's desk-activity block (older builds wrote "loci")
    .replace(/<loki-tasks>[\s\S]*?<\/loki-tasks>/g, "") // the board's tasks assigned to this conversation, from the mod
    .replace(/<attachment\b[^>]*\/>/g, "") // a file the message carried (loki's uploads, Letta's channels): a chip, not words
    .replace(/<attachment\b[^>]*>[\s\S]*?<\/attachment>/g, "")
    .replace(/<skill_content[^>]*>[\s\S]*?<\/skill_content>/g, "") // a skill's body, injected by the harness when the agent loads it
    .replace(/<channel-notification[^>]*>[\s\S]*?<\/channel-notification>/g, "")
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "")
    .replace(/^\s*Full transcript available at: \S+\s*$/gm, "")
    .replace(/^\s*\{"type":\s*"system_alert"[\s\S]*?\}\s*$/gm, "");
}

/** Undo the HTML escaping Letta applies inside task-notification results. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

export interface HarnessEvent {
  /** e.g. "background task bash_24 completed" */
  text: string;
  /** e.g. the task's summary line */
  summary: string | null;
  /** the raw result, decoded, for a disclosure */
  detail: string | null;
}

/**
 * Pull the harness-injected events out of a user message: task notifications, compaction notes, the
 * desk-activity and board-tasks blocks the mod appends, and skill bodies the harness loads. Each becomes a quiet event
 * row instead of words in the user's bubble.
 */
export function extractHarnessEvents(text: string): HarnessEvent[] {
  const out: HarnessEvent[] = [];
  for (const m of text.matchAll(/<lo[ck]i-desk(?:\s+desk="([^"]*)")?[^>]*>([\s\S]*?)<\/lo[ck]i-desk>/g)) {
    const desk = m[1] ?? null;
    const lines = m[2].split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
    out.push({
      text: "canvas activity",
      summary: `${lines.length} ${lines.length === 1 ? "gesture" : "gestures"}${desk ? ` on ${desk}` : ""}`,
      detail: lines.length ? lines.join("\n") : null,
    });
  }
  for (const m of text.matchAll(/<loki-tasks>([\s\S]*?)<\/loki-tasks>/g)) {
    const lines = m[1].split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim());
    out.push({
      text: "board tasks",
      summary: lines.length ? `${lines.length} assigned to this chat` : "none assigned any more",
      detail: lines.length ? lines.join("\n") : null,
    });
  }
  for (const m of text.matchAll(/<skill_content(?:\s+name="([^"]*)")?[^>]*>([\s\S]*?)<\/skill_content>/g)) {
    const body = m[2].trim();
    out.push({ text: "skill loaded", summary: m[1] ?? null, detail: body || null });
  }
  for (const m of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const body = m[1];
    const tag = (name: string) => body.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`))?.[1]?.trim() ?? null;
    const id = tag("task-id");
    const status = tag("status");
    const summary = tag("summary");
    const result = tag("result");
    out.push({
      text: `background task${id ? ` ${id}` : ""}${status ? ` ${status}` : ""}`,
      summary: summary ? decodeEntities(summary) : null,
      detail: result ? decodeEntities(result) : null,
    });
  }
  for (const m of text.matchAll(/^\s*(\{"type":\s*"system_alert"[\s\S]*?\})\s*$/gm)) {
    try {
      const alert = JSON.parse(m[1]) as { message?: string };
      const msg = typeof alert.message === "string" ? alert.message : "";
      out.push({ text: /hidden from view|compact/i.test(msg) ? "context compacted" : "system alert", summary: msg.split("\n")[0]?.slice(0, 160) ?? null, detail: msg || null });
    } catch {
      // not JSON after all; leave it to the text
    }
  }
  return out;
}

/** Text of a Letta message's content (string or text parts). */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (typeof p === "object" && p !== null && (p as { type?: string }).type === "text" ? String((p as { text?: string }).text ?? "") : ""))
    .join("");
}

/** The files a message carried: its attachment tags that name a local path. */
export function messageFiles(text: string): FileRef[] {
  const out: FileRef[] = [];
  for (const m of text.matchAll(/<attachment\b([^>]*?)\/?>/g)) {
    const attrs = new Map([...m[1].matchAll(/([a-z_]+)="([^"]*)"/g)].map((a) => [a[1], decodeEntities(a[2])]));
    const path = attrs.get("local_path");
    if (!path) continue;
    const size = Number(attrs.get("size_bytes"));
    out.push({ path, name: attrs.get("name") || path.split("/").pop() || path, ...(Number.isFinite(size) ? { size } : {}), ...(attrs.get("mime_type") ? { mime: attrs.get("mime_type") } : {}) });
  }
  return out;
}

/**
 * A message's text as a thread shows it, the same from every source: its text parts a line each, and an "[image]"
 * line where it carried a picture (the local log's own rendering; the bubble shows the picture when it has it).
 */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const lines: string[] = [];
  for (const p of content) {
    if (typeof p !== "object" || p === null) continue;
    const type = (p as { type?: string }).type;
    if (type === "text" && typeof (p as { text?: unknown }).text === "string") lines.push((p as { text: string }).text);
    else if (type === "image") lines.push("[image]");
  }
  return lines.join("\n");
}

/** A scheduled task's prompt arrives with this opening (daemon/schedule.ts): not a person's message. */
export const isScheduledPrompt = (text: string): boolean => /^\s*Scheduled task\b/.test(text);

/** Heuristic: does this assistant message end by asking the user something? */
export function looksLikeQuestion(text: string | null): boolean {
  if (!text) return false;
  const tail = text.trim().split("\n").filter(Boolean).slice(-3).join(" ");
  return /\?\s*$/.test(tail) || /\b(should I|do you want|which (one|of)|let me know|your call|confirm)\b/i.test(tail);
}

/** The most of a tool's input or output a step keeps: enough to read, not a whole log on every frame. */
export const TOOL_TEXT_MAX = 4000;

const cap = (s: string): string => (s.length > TOOL_TEXT_MAX ? `${s.slice(0, TOOL_TEXT_MAX)}\n… ${s.length - TOOL_TEXT_MAX} more characters` : s);

const argsOf = (input: unknown): Record<string, unknown> | null => {
  if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>;
  if (typeof input !== "string") return null;
  try {
    const parsed = JSON.parse(input) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null; // partial or non-JSON arguments
  }
};

/**
 * The part of a tool's input a reader recognises, trimmed: the shell command (`cmd` in Letta's Codex-style toolset,
 * `command` in Claude-style Bash), the path, the pattern, … in this order; the step's input and its label both use it.
 */
const ARG_KEYS = ["cmd", "command", "file_path", "path", "pattern", "query", "url", "skill", "prompt", "description"];
const argOf = (args: Record<string, unknown>): string | undefined => {
  const key = ARG_KEYS.find((k) => typeof args[k] === "string" && (args[k] as string).trim());
  return key ? (args[key] as string).trim() : undefined;
};

/**
 * What a step shows as the tool's input: the part a reader recognises in full (the shell command, the path, the
 * pattern), else the whole input as JSON; nothing when it has none, or it has not finished arriving.
 */
export function toolInput(name: string, input: unknown): string | undefined {
  const args = argsOf(input);
  if (!args) return undefined;
  const pick = name === "AskUserQuestion" ? undefined : argOf(args);
  if (pick) return cap(pick);
  const json = JSON.stringify(args, null, 2);
  return json === "{}" ? undefined : cap(json);
}

/** What came back from a tool, as text: a string, the text of content parts, or JSON for anything else. */
export function toolOutput(raw: unknown): string | undefined {
  let text: string;
  if (typeof raw === "string") text = raw;
  else if (Array.isArray(raw)) text = raw.map((p) => (typeof p === "string" ? p : p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join("\n");
  else if (raw === undefined || raw === null) return undefined;
  else text = JSON.stringify(raw, null, 2);
  return text ? cap(text) : undefined;
}

/** The longest description a step keeps: it is one line of the thread, not an essay. */
const DESCRIPTION_MAX = 200;

/** A call as a step: its name, its id, its input when it has one, and what it is for when the agent said. */
export function toolStep(name: string, input: unknown, id?: string | null): ToolStep {
  const step: ToolStep = { name };
  if (id) step.id = id;
  const given = toolInput(name, input);
  if (given !== undefined) step.input = given;
  const said = argsOf(input)?.description;
  if (typeof said === "string" && said.trim() && said.trim() !== given) step.description = said.trim().split("\n")[0].slice(0, DESCRIPTION_MAX);
  return step;
}

/** The step once its result came back (a new object: rows that changed are new). */
export function withResult(step: ToolStep, raw: unknown, failed: boolean): ToolStep {
  const output = toolOutput(raw);
  return { ...step, ...(output !== undefined ? { output } : {}), ...(failed ? { failed: true } : {}) };
}

/**
 * A one-line label for a tool call: the tool name plus the part of its input
 * a reader recognises (the shell command, the file path, the pattern).
 */
export function toolLabel(name: string, input: unknown): string {
  const args = argsOf(input);
  if (!args) return name;
  const question = name === "AskUserQuestion" ? (args.questions as Array<{ question?: string }> | undefined)?.[0]?.question?.trim() : undefined;
  const target = question || argOf(args)?.split("\n")[0];
  if (!target) return name;
  return `${name} · ${target.length > 80 ? target.slice(0, 77) + "…" : target}`;
}
