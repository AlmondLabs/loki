/** An image attached to an outgoing message: base64 payload plus a data URL for showing it. */
export interface ImageAttachment {
  id: string;
  mediaType: string;
  data: string;
  url: string;
}

export type UserContent = string | Array<{ type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } }>;

/**
 * The `content` of a create_message user message: a plain string when there are
 * no images, otherwise text and image parts in the shape Letta's app-server
 * validates (`{ type: "image", source: { type: "base64", media_type, data } }`).
 */
export function buildUserContent(text: string, images: ImageAttachment[] = [], context?: string): UserContent {
  if (!images.length && !context) return text;
  const parts: Exclude<UserContent, string> = [];
  if (context) parts.push({ type: "text", text: context });
  if (text.trim()) parts.push({ type: "text", text });
  for (const img of images) parts.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
  return parts;
}

/**
 * The environment note Letta Desktop attaches to every typed message, in the
 * same shape, so an agent talked to from the canvas keeps its sense of time and
 * place. Rendered transcripts strip system reminders, so the user never sees it.
 */
export function environmentReminder(opts: { now?: Date; folder?: string | null; desk?: string | null; locale?: string } = {}): string {
  const now = opts.now ?? new Date();
  const when = now.toLocaleString(opts.locale ?? undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short" });
  const lines = [
    "<system-reminder>",
    "This is an automated message providing context about the user's environment.",
    "The user is sending a message via the loki canvas (a browser tab, not the Letta desktop app).",
    `User's device local time: ${when}`,
  ];
  if (opts.folder) lines.push(`Current remote working directory: ${opts.folder}`);
  if (opts.desk) lines.push(`The user is looking at the loki desk for this conversation ("${opts.desk}").`);
  lines.push("</system-reminder>");
  return lines.join("\n");
}


/** One question from Letta's AskUserQuestion tool. */
export interface AskQuestion {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
}

/** Read the tool's input defensively: only questions with text and at least one option count. */
export function askQuestions(input: unknown): AskQuestion[] {
  const qs = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(qs)) return [];
  const out: AskQuestion[] = [];
  for (const q of qs as Array<Record<string, unknown>>) {
    if (typeof q?.question !== "string" || !q.question.trim()) continue;
    const options = Array.isArray(q.options)
      ? (q.options as Array<Record<string, unknown>>).filter((o) => typeof o?.label === "string" && o.label.trim()).map((o) => ({ label: o.label as string, description: typeof o.description === "string" ? o.description : undefined }))
      : [];
    out.push({ question: q.question, header: typeof q.header === "string" ? q.header : undefined, options, multiSelect: q.multiSelect === true });
  }
  return out;
}

/**
 * The tool input handed back with the answers filled in, keyed by question text
 * (multi-select answers are labels joined with ", "), which is how Letta's own
 * channel clients answer: an allow decision with this as `updated_input`.
 */
export function buildQuestionAnswer(input: unknown, answers: Record<string, string | string[]>): Record<string, unknown> {
  const base = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const prev = (base.answers as Record<string, string> | undefined) ?? {};
  const flat: Record<string, string> = { ...prev };
  for (const [q, a] of Object.entries(answers)) flat[q] = Array.isArray(a) ? a.join(", ") : a;
  return { ...base, answers: flat };
}
