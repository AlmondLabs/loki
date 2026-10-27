/**
 * The harness injects machinery into transcripts as ordinary messages:
 * background-task notifications, skill bodies, loki's own desk-activity block,
 * and, in history imported from Letta, its system reminders and compaction notes.
 * Both halves of loki need to recognise them: the mod for the chat mirror, the
 * browser for the Catch Up thread.
 */

import type { FileRef, ToolStep } from "./attention/transcript.ts";

/** A message's text with the harness's injected blocks taken out (reminders, desk activity, attachment tags, skill bodies, notifications): what the person or agent actually wrote. */
export function stripHarnessMarkup(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<system-alert>[\s\S]*?<\/system-alert>/g, "")
    .replace(/<lo[ck]i-desk[^>]*>[\s\S]*?<\/lo[ck]i-desk>/g, "") // the mod's desk-activity block (older builds wrote "loci")
    .replace(/<loki-tasks>[\s\S]*?<\/loki-tasks>/g, "") // the tasks assigned to this conversation in Tasks, from the mod
    .replace(/<loki-moved\b[^>]*\/>/g, "") // the chat moved to this Mac (plan 023, addendum A5): a quiet row
    .replace(/<attachment\b[^>]*\/>/g, "") // a file the message carried (loki's uploads, Letta's channels): a chip, not words
    .replace(/<attachment\b[^>]*>[\s\S]*?<\/attachment>/g, "")
    .replace(/<skill_content[^>]*>[\s\S]*?<\/skill_content>/g, "") // a skill's body, injected by the harness when the agent loads it
    .replace(/<channel-notification[^>]*>[\s\S]*?<\/channel-notification>/g, "")
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "")
    .replace(/^\s*Full transcript available at: \S+\s*$/gm, "")
    .replace(/^\s*\{"type":\s*"system_alert"[\s\S]*?\}\s*$/gm, "");
}

/** Undo the HTML escaping inside task-notification results (daemon/background.ts escapes them, as Letta did). */
export function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** One injected block as the quiet event row it becomes in a thread: a line, a summary, and the decoded detail for its disclosure. */
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
 * desk-activity and assigned-tasks blocks the mod appends, and skill bodies the harness loads. Each becomes a quiet event
 * row instead of words in the user's bubble.
 */
export function extractHarnessEvents(text: string): HarnessEvent[] {
  const out: HarnessEvent[] = [];
  for (const m of text.matchAll(/<lo[ck]i-desk(?:\s+desk="([^"]*)")?[^>]*>([\s\S]*?)<\/lo[ck]i-desk>/g)) {
    const desk = m.at(1) ?? null;
    const lines = m[2]
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("- "))
      .map((l) => l.slice(2));
    out.push({
      text: "canvas activity",
      summary: `${lines.length} ${lines.length === 1 ? "gesture" : "gestures"}${desk ? ` on ${desk}` : ""}`,
      detail: lines.length ? lines.join("\n") : null,
    });
  }
  for (const m of text.matchAll(/<loki-tasks>([\s\S]*?)<\/loki-tasks>/g)) {
    const lines = m[1]
      .split("\n")
      .filter((l) => l.startsWith("- "))
      .map((l) => l.slice(2).trim());
    out.push({
      text: "assigned tasks",
      summary: lines.length ? `${lines.length} assigned to this chat` : "none assigned any more",
      detail: lines.length ? lines.join("\n") : null,
    });
  }
  for (const m of text.matchAll(/<loki-moved\b([^>]*)\/>/g)) {
    const was = decodeEntities(/\bfrom="([^"]*)"/.exec(m[1])?.[1] ?? "");
    const now = decodeEntities(/\bto="([^"]*)"/.exec(m[1])?.[1] ?? "");
    out.push({ text: `moved to ${now || "this Mac"}`, summary: was ? `came over from ${was}` : null, detail: null });
  }
  for (const m of text.matchAll(/<skill_content(?:\s+name="([^"]*)")?[^>]*>([\s\S]*?)<\/skill_content>/g)) {
    const body = m[2].trim();
    out.push({ text: "skill loaded", summary: m.at(1) ?? null, detail: body || null });
  }
  for (const m of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const body = m[1];
    const tag = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`).exec(body)?.[1]?.trim() ?? null;
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
      out.push({
        text: /hidden from view|compact/i.test(msg) ? "context compacted" : "system alert",
        summary: msg.split("\n")[0]?.slice(0, 160) ?? null,
        detail: msg || null,
      });
    } catch {
      // not JSON after all; leave it to the text
    }
  }
  return out;
}

/** A text part's value as text: a string as it is, nothing as empty, anything else as JSON. */
const textOf = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));
/** Text of a message's content (a string, or its text parts joined); other parts and any other shape give nothing. */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (typeof p === "object" && p !== null && (p as { type?: unknown }).type === "text" ? textOf((p as { text?: unknown }).text) : ""))
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
    out.push({
      path,
      name: attrs.get("name") || path.split("/").pop() || path,
      ...(Number.isFinite(size) ? { size } : {}),
      ...(attrs.get("mime_type") ? { mime: attrs.get("mime_type") } : {}),
    });
  }
  return out;
}

/** The pictures in a message's content, as the model got them: base64 data and its type (plan 029). */
export function contentImages(content: unknown): Array<{ data: string; mimeType: string }> {
  if (!Array.isArray(content)) return [];
  return content.flatMap((p) => {
    const part = p as { type?: unknown; data?: unknown; mimeType?: unknown } | null;
    return part?.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string" ? [{ data: part.data, mimeType: part.mimeType }] : [];
  });
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

/**
 * A copy of `s` that holds its own characters (plan 042). V8 keeps a cut of a long text as a view into the whole of it,
 * so a 4,000-character cut of a megabyte of tool output kept the megabyte for as long as the daemon kept the step. A
 * round trip through JSON is the one copy every engine makes whole, lone surrogates included.
 */
export function ownText(s: string): string {
  return JSON.parse(JSON.stringify(s)) as string;
}

/** The line `cap` ends a cut text with. */
const MORE = /\n… \d+ more characters$/;

/**
 * A text cut to TOOL_TEXT_MAX, with a line saying how much more there was. A text already cut is left as it is: the
 * daemon caps a tool's output before it sends it (plan 035), and the app caps what it is given again.
 */
const cap = (s: string): string => {
  if (s.length <= TOOL_TEXT_MAX) return s;
  const more = MORE.exec(s);
  if (more && s.length - more[0].length === TOOL_TEXT_MAX) return s;
  return ownText(`${s.slice(0, TOOL_TEXT_MAX)}\n… ${s.length - TOOL_TEXT_MAX} more characters`);
};

const shrink = (v: unknown): unknown => {
  if (typeof v === "string") return v.length > TOOL_TEXT_MAX ? ownText(v.slice(0, TOOL_TEXT_MAX)) : v;
  if (Array.isArray(v)) return v.map(shrink);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shrink(x)]));
  return v;
};

/**
 * A tool's arguments as a thread needs them (plan 035): every string in them, however deep, cut to TOOL_TEXT_MAX, so
 * a `write` does not carry its whole file to every client. Its label and shown input read the same, since neither
 * shows more than that. Arguments still arriving as text are left whole: cut, they might not parse.
 */
export function toolArgsShown(args: unknown): unknown {
  return typeof args === "string" ? args : shrink(args);
}

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
  const key = ARG_KEYS.find((k) => typeof args[k] === "string" && args[k].trim());
  return key ? (args[key] as string).trim() : undefined;
};

/** The question card's tool: `ask_user`, or `AskUserQuestion` in chats from before October 2026 and from Letta. */
const isQuestionTool = (name: string): boolean => name === "ask_user" || name === "AskUserQuestion";

/**
 * What a step shows as the tool's input: the part a reader recognises in full (the shell command, the path, the
 * pattern), else the whole input as JSON; nothing when it has none, or it has not finished arriving.
 */
export function toolInput(name: string, input: unknown): string | undefined {
  const args = argsOf(input);
  if (!args) return undefined;
  const pick = isQuestionTool(name) ? undefined : argOf(args);
  if (pick) return cap(pick);
  const json = JSON.stringify(args, null, 2);
  return json === "{}" ? undefined : cap(json);
}

/** A tool result's whole text: its text parts joined, or the value as JSON; undefined when it has none. */
function toolText(raw: unknown): string | undefined {
  let text: string;
  if (typeof raw === "string") text = raw;
  else if (Array.isArray(raw))
    text = raw
      .map((p) =>
        typeof p === "string" ? p : p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "",
      )
      .join("\n");
  else if (raw === undefined || raw === null) return undefined;
  else text = JSON.stringify(raw, null, 2);
  return text || undefined;
}

/** What came back from a tool, as text: a string, the text of content parts, or JSON for anything else., cut to TOOL_TEXT_MAX. */
export function toolOutput(raw: unknown): string | undefined {
  const text = toolText(raw);
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

/** An error's last line that says something: where a shell or a tool says how it ended. */
const lastLine = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1) ?? "";

/**
 * What a failed call's result says went wrong: its last line before the harness's own note (pi closes a failed bash
 * result with `<harness>[error] Command exited with code 127</harness>`), and that note too when it says more than an
 * exit code (a timeout).
 */
export function errorOf(output: string): string {
  const note = /<harness>\s*([\s\S]*?)\s*<\/harness>\s*$/.exec(output);
  const said = lastLine(note ? output.slice(0, note.index) : output);
  const why = note ? lastLine(note[1]).replace(/^\[error\]\s*/, "") : "";
  return [said, /exited with code \d+/.test(why) ? "" : why].filter(Boolean).join(" — ");
}

/**
 * The step once its result came back (a new object: rows that changed are new). A failed one keeps what went wrong
 * (`error`), read from the whole result before it is cut to TOOL_TEXT_MAX: the error is at the end, which the cut drops.
 */
export function withResult(step: ToolStep, raw: unknown, failed: boolean): ToolStep {
  const output = toolOutput(raw);
  const error = failed ? errorOf(toolText(raw) ?? "") : "";
  return { ...step, ...(output !== undefined ? { output } : {}), ...(failed ? { failed: true } : {}), ...(error ? { error } : {}) };
}

/**
 * A one-line label for a tool call: the tool name plus the part of its input
 * a reader recognises (the shell command, the file path, the pattern).
 */
export function toolLabel(name: string, input: unknown): string {
  const args = argsOf(input);
  if (!args) return name;
  const question = isQuestionTool(name) ? (args.questions as Array<{ question?: string }> | undefined)?.[0]?.question?.trim() : undefined;
  const target = question || argOf(args)?.split("\n")[0];
  if (!target) return name;
  return `${name} · ${target.length > 80 ? target.slice(0, 77) + "…" : target}`;
}

/** The mark a chat's thread keeps where it moved to another Mac (plan 023, addendum A5); drawn as a quiet row. */
export function movedMark(from: string, to: string): string {
  const attr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<loki-moved from="${attr(from)}" to="${attr(to)}"/>`;
}
