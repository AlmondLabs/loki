import type { FileRef, PlanItem, ToolStep } from "./attention/transcript.ts";
import { answerOf, unansweredText, type AdvisorAnswer } from "./advisor.ts";
import { shellTitle } from "./shell-title.ts";

const ANSWER_BLOCK = /<loki-advisor-answer\b[^>]*>[\s\S]*?<\/loki-advisor-answer>/g;

export function stripHarnessMarkup(text: string): string {
  return text
    .replace(ANSWER_BLOCK, "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<lo[ck]i-desk[^>]*>[\s\S]*?<\/lo[ck]i-desk>/g, "")
    .replace(/<loki-tasks>[\s\S]*?<\/loki-tasks>/g, "")
    .replace(/<loki-moved\b[^>]*\/>/g, "")
    .replace(/<loki-suggested\b[^>]*\/>/g, "")
    .replace(/<loki-chat-message\b[^>]*>[\s\S]*?<\/loki-chat-message>/g, "")
    .replace(REPLIES_BLOCK, "")
    .replace(/<attachment\b[^>]*\/>/g, "")
    .replace(/<attachment\b[^>]*>[\s\S]*?<\/attachment>/g, "")
    .replace(/<skill_content[^>]*>[\s\S]*?<\/skill_content>/g, "")
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "");
}

const REPLIES_BLOCK = /<loki-replies>[\s\S]*?<\/loki-replies>/g;
const OPEN_TAG = "<loki-replies>";
const REPLIES_MIN = 2;
export const REPLIES_MAX = 4;
const REPLY_CHARS = 80;

export function repliesOf(text: string): string[] | null {
  const m = /<loki-replies>([\s\S]*?)<\/loki-replies>\s*$/.exec(text);
  if (!m) return null;
  const lines = m[1]
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.every((l) => /^[-*]\s+\S/.test(l))) return null;
  const options = lines.map((l) => l.replace(/^[-*]\s+/, ""));
  if (options.length < REPLIES_MIN || options.length > REPLIES_MAX || options.some((o) => o.length > REPLY_CHARS)) return null;
  return new Set(options).size === options.length ? options : null;
}

export function withoutReplies(text: string): string {
  const cut = text.replace(REPLIES_BLOCK, "");
  const open = cut.indexOf(OPEN_TAG);
  if (open >= 0) return cut.slice(0, open).trimEnd();
  const lt = cut.lastIndexOf("<");
  const tail = lt >= 0 ? cut.slice(lt) : "";
  return tail.length >= 2 && OPEN_TAG.startsWith(tail) ? cut.slice(0, lt).trimEnd() : cut;
}

export function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

export interface HarnessEvent {
  text: string;
  summary: string | null;
  detail: string | null;
  link?: { agent_id: string; conversation_id: string };
  advisor_chat?: string;
}

const ANSWER_PREVIEW_LINES = 3;
const ANSWER_PREVIEW_CHARS = 300;

function answerPreview(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const shown = lines.slice(0, ANSWER_PREVIEW_LINES).join("\n");
  if (shown.length > ANSWER_PREVIEW_CHARS) return `${shown.slice(0, ANSWER_PREVIEW_CHARS - 1).trimEnd()}…`;
  return lines.length > ANSWER_PREVIEW_LINES ? `${shown}…` : shown;
}

function advisorEvent(a: AdvisorAnswer): HarnessEvent {
  const text = a.from === "person" ? "From the advisor · you asked" : "From the advisor · the agent asked";
  return a.state === "answered"
    ? { text, summary: answerPreview(a.text), detail: a.text, advisor_chat: a.advisor_chat }
    : { text, summary: unansweredText(a.reason), detail: null, advisor_chat: a.advisor_chat };
}

export function extractHarnessEvents(whole: string): HarnessEvent[] {
  const answers = [...whole.matchAll(ANSWER_BLOCK)].flatMap((m) => answerOf(m[0]) ?? []);
  const text = whole.replace(ANSWER_BLOCK, "");
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
  for (const m of text.matchAll(/<loki-moved\b([^>]*)\/>/g)) {
    const was = decodeEntities(/\bfrom="([^"]*)"/.exec(m[1])?.[1] ?? "");
    const now = decodeEntities(/\bto="([^"]*)"/.exec(m[1])?.[1] ?? "");
    out.push({ text: `moved to ${now || "this Mac"}`, summary: was ? `came over from ${was}` : null, detail: null });
  }
  const suggested = suggestedOf(text);
  if (suggested)
    out.push({
      text: "suggested in another chat",
      summary: suggested.title || null,
      detail: null,
      link: { agent_id: suggested.from_agent, conversation_id: suggested.from_chat },
    });
  const message = chatMessageOf(text);
  if (message)
    out.push({
      text: `from ${message.title || "another chat"}`,
      summary:
        message.text
          .split("\n")
          .find((l) => l.trim())
          ?.trim()
          .slice(0, 120) ?? null,
      detail: message.text,
      link: { agent_id: message.from_agent, conversation_id: message.from_chat },
    });
  out.push(...answers.map(advisorEvent));
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
  return out;
}

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

export function contentImages(content: unknown): Array<{ data: string; mimeType: string }> {
  if (!Array.isArray(content)) return [];
  return content.flatMap((p) => {
    const part = p as { type?: unknown; data?: unknown; mimeType?: unknown } | null;
    return part?.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string" ? [{ data: part.data, mimeType: part.mimeType }] : [];
  });
}

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

export const isScheduledPrompt = (text: string): boolean => /^\s*Scheduled task\b/.test(text);

export function looksLikeQuestion(text: string | null): boolean {
  if (!text) return false;
  const tail = text.trim().split("\n").filter(Boolean).slice(-3).join(" ");
  return /\?\s*$/.test(tail) || /\b(should I|do you want|which (one|of)|let me know|your call|confirm)\b/i.test(tail);
}

export const TOOL_TEXT_MAX = 4000;

/**
 * A copy of `s` that holds its own characters (plan 042). V8 keeps a cut of a long text as a view into the whole of it,
 * so a 4,000-character cut of a megabyte of tool output kept the megabyte for as long as the daemon kept the step. A
 * round trip through JSON is the one copy every engine makes whole, lone surrogates included.
 */
export function ownText(s: string): string {
  return JSON.parse(JSON.stringify(s)) as string;
}

const MORE = /\n… \d+ more characters$/;

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
    return null;
  }
};

const ARG_KEYS = ["command", "file_path", "path", "pattern", "query", "url", "skill", "prompt"];
const argOf = (args: Record<string, unknown>): string | undefined => {
  const key = ARG_KEYS.find((k) => typeof args[k] === "string" && args[k].trim());
  return key ? (args[key] as string).trim() : undefined;
};

const isQuestionTool = (name: string): boolean => name === "user_ask";

const NAMED_BY_INSTEAD_OF_DESCRIPTION: Partial<Record<string, string>> = { ticket_propose: "title", mcp__loki__ticket_propose: "title" };

const descriptionOf = (name: string, args: Record<string, unknown>): string | undefined => {
  if (NAMED_BY_INSTEAD_OF_DESCRIPTION[name]) return undefined;
  const said = args.description;
  return typeof said === "string" && said.trim() ? said.trim() : undefined;
};

export function toolInput(name: string, input: unknown): string | undefined {
  const args = argsOf(input);
  if (!args) return undefined;
  const pick = isQuestionTool(name) ? undefined : argOf(args);
  if (pick) return cap(pick);
  const rest = descriptionOf(name, args) ? Object.fromEntries(Object.entries(args).filter(([k]) => k !== "description")) : args;
  const json = JSON.stringify(rest, null, 2);
  return json === "{}" ? undefined : cap(json);
}

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

export function toolOutput(raw: unknown): string | undefined {
  const text = toolText(raw);
  return text ? cap(text) : undefined;
}

const DESCRIPTION_MAX = 200;

export function toolStep(name: string, input: unknown, id?: string | null): ToolStep {
  const step: ToolStep = { name };
  if (id) step.id = id;
  const given = toolInput(name, input);
  if (given !== undefined) step.input = given;
  const args = argsOf(input);
  const said = args && descriptionOf(name, args);
  if (said && said !== given) step.description = said.split("\n")[0].slice(0, DESCRIPTION_MAX);
  return step;
}

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

export function withResult(step: ToolStep, raw: unknown, failed: boolean): ToolStep {
  const output = toolOutput(raw);
  const error = failed ? errorOf(toolText(raw) ?? "") : "";
  const plan = step.name === PLAN_TOOL && !failed ? planItems(toolText(raw) ?? "") : null;
  return {
    ...step,
    ...(output !== undefined ? { output } : {}),
    ...(failed ? { failed: true } : {}),
    ...(error ? { error } : {}),
    ...(plan ? { plan } : {}),
  };
}

export const PLAN_TOOL = "plan";

const PLAN_MARK: Partial<Record<string, PlanItem["status"]>> = { "[x]": "completed", "[~]": "in_progress", "[ ]": "pending" };

export function planItems(text: string): PlanItem[] | null {
  const lines = text.split("\n").filter((l) => l.trim());
  if (!lines.length) return null;
  const items: PlanItem[] = [];
  for (const l of lines) {
    const status = PLAN_MARK[l.slice(0, 3)];
    if (!status || l[3] !== " ") return null;
    items.push({ content: l.slice(4).trim(), status });
  }
  return items;
}

export function toolLabel(name: string, input: unknown): string {
  const args = argsOf(input);
  if (!args) return name;
  const question = isQuestionTool(name) ? (args.questions as Array<{ question?: string }> | undefined)?.[0]?.question?.trim() : undefined;
  const arg = typeof args.command === "string" && args.command.trim() ? shellTitle(args.command.trim()) : argOf(args);
  const namedBy = NAMED_BY_INSTEAD_OF_DESCRIPTION[name];
  const ownName = namedBy && typeof args[namedBy] === "string" ? args[namedBy].trim() : undefined;
  const target = question || (arg ?? ownName)?.split("\n")[0];
  if (!target) return name;
  return `${name} · ${target.length > 80 ? target.slice(0, 77) + "…" : target}`;
}

export function movedMark(from: string, to: string): string {
  const attr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<loki-moved from="${attr(from)}" to="${attr(to)}"/>`;
}

export interface SuggestedFrom {
  from_agent: string;
  from_chat: string;
  title: string;
}

export function suggestedMark(from: SuggestedFrom): string {
  const attr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<loki-suggested from_agent="${attr(from.from_agent)}" from_chat="${attr(from.from_chat)}" title="${attr(from.title)}"/>`;
}

export function suggestedOf(text: string): SuggestedFrom | null {
  const m = /<loki-suggested\b([^>]*)\/>/.exec(text);
  if (!m) return null;
  const field = (name: string) => decodeEntities(new RegExp(`\\b${name}="([^"]*)"`).exec(m[1])?.[1] ?? "");
  const fromChat = field("from_chat");
  return fromChat ? { from_agent: field("from_agent"), from_chat: fromChat, title: field("title") } : null;
}

export function chatMessageBlock(from: SuggestedFrom, text: string): string {
  const attr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = text.replace(/<\/loki-chat-message/g, "&lt;/loki-chat-message");
  return `<loki-chat-message from_agent="${attr(from.from_agent)}" from_chat="${attr(from.from_chat)}" title="${attr(from.title)}">\n${body}\n</loki-chat-message>`;
}

export function chatMessageOf(text: string): (SuggestedFrom & { text: string }) | null {
  const m = /<loki-chat-message\b([^>]*)>([\s\S]*?)<\/loki-chat-message>/.exec(text);
  if (!m) return null;
  const field = (name: string) => decodeEntities(new RegExp(`\\b${name}="([^"]*)"`).exec(m[1])?.[1] ?? "");
  const fromChat = field("from_chat");
  return fromChat
    ? {
        from_agent: field("from_agent"),
        from_chat: fromChat,
        title: field("title"),
        text: m[2].trim().replace(/&lt;\/loki-chat-message/g, "</loki-chat-message"),
      }
    : null;
}
