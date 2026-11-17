export interface ImageAttachment {
  id: string;
  mediaType: string;
  data: string;
  url: string;
}

export interface FileAttachment {
  id: string;
  kind: "file";
  path: string;
  name: string;
  size: number;
  mime: string;
}

export type Attachment = ImageAttachment | FileAttachment;

export const isFileAttachment = (a: Attachment): a is FileAttachment => "kind" in a;

const xmlAttr = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function attachmentTag(f: { path: string; name: string; size: number; mime: string }): string {
  return `<attachment kind="file" local_path="${xmlAttr(f.path)}" name="${xmlAttr(f.name)}" mime_type="${xmlAttr(f.mime)}" size_bytes="${f.size}" />`;
}

export function withAttachments(text: string, files: Array<{ path: string; name: string; size: number; mime: string }>): string {
  if (!files.length) return text;
  const tags = files.map(attachmentTag).join("\n");
  return text.trim() ? `${text}\n\n${tags}` : tags;
}

export function environmentReminder(opts: { now?: Date; desk?: string | null; labels?: readonly string[] | null; locale?: string } = {}): string {
  const now = opts.now ?? new Date();
  const when = localTime(now, opts.locale);
  const lines = [
    "<system-reminder>",
    "This is an automated message providing context about the user's environment.",
    "The user is sending a message via loki, on their Mac or a paired phone.",
    `User's device local time: ${when}`,
  ];
  if (opts.desk) lines.push(`The user is looking at this conversation in loki, the chat ("${opts.desk}").`);
  if (opts.labels?.length) lines.push(labelsLine(opts.labels));
  lines.push("</system-reminder>");
  return lines.join("\n");
}

function labelsLine(labels: readonly string[]): string {
  return `The user has labelled this chat: ${labels.join(", ")}.`;
}

export function daemonTimeReminder(now: Date = new Date(), locale?: string): string {
  return ["<system-reminder>", `Local time on the user's Mac, as loki sends this: ${localTime(now, locale)}`, "</system-reminder>"].join("\n");
}

export const ENV_NOTE_EVERY_MS = 30 * 60_000;

export interface EnvNoteTold {
  at: number;
  day: string;
  zone: string;
  desk: string | null;
  labels?: string;
}

export function environmentNote(
  last: EnvNoteTold | undefined,
  opts: { now?: Date; desk?: string | null; labels?: readonly string[] | null; locale?: string; zone?: string } = {},
): { text: string | null; told: EnvNoteTold } {
  const now = opts.now ?? new Date();
  const desk = opts.desk ?? null;
  const labels = opts.labels ? opts.labels.join(", ") : undefined;
  const told: EnvNoteTold = {
    at: now.getTime(),
    day: `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`,
    zone: opts.zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    desk,
    ...(labels !== undefined ? { labels } : {}),
  };
  if (!last) return { text: environmentReminder({ now, desk, labels: opts.labels, locale: opts.locale }), told };
  const renamed = desk !== null && desk !== last.desk;
  const relabelled = labels !== undefined && labels !== (last.labels ?? "");
  const due = told.at - last.at >= ENV_NOTE_EVERY_MS || told.day !== last.day || told.zone !== last.zone;
  if (!due && !renamed && !relabelled) return { text: null, told: { ...last, desk: desk ?? last.desk } };
  const lines = ["<system-reminder>", `User's device local time: ${localTime(now, opts.locale)}`];
  if (renamed) lines.push(`The user is looking at this conversation in loki, the chat ("${desk}").`);
  if (relabelled) lines.push(labels ? labelsLine(opts.labels ?? []) : "The user removed this chat's labels.");
  lines.push("</system-reminder>");
  return { text: lines.join("\n"), told: labels === undefined && last.labels !== undefined ? { ...told, labels: last.labels } : told };
}

function localTime(now: Date, locale?: string): string {
  return now.toLocaleString(locale ?? undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
}

export interface AskQuestion {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
}

export function askQuestions(input: unknown): AskQuestion[] {
  const qs = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(qs)) return [];
  const out: AskQuestion[] = [];
  for (const q of qs as Array<Record<string, unknown> | null>) {
    if (typeof q?.question !== "string" || !q.question.trim()) continue;
    const options = Array.isArray(q.options)
      ? (q.options as Array<Record<string, unknown> | null>)
          .filter((o): o is Record<string, unknown> => typeof o?.label === "string" && o.label.trim() !== "")
          .map((o) => ({ label: o.label as string, description: typeof o.description === "string" ? o.description : undefined }))
      : [];
    out.push({
      question: q.question,
      header: typeof q.header === "string" ? q.header : undefined,
      options,
      multiSelect: q.multi_select === true,
    });
  }
  return out;
}

/**
 * The tool input handed back with the answers filled in, keyed by question text
 * (multi-select answers are labels joined with ", "), which the daemon's tool reads: an allow decision with this as
 * `updated_input`.
 */
export function buildQuestionAnswer(input: unknown, answers: Record<string, string | string[]>): Record<string, unknown> {
  const base = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const prev = (base.answers as Record<string, string> | undefined) ?? {};
  const flat: Record<string, string> = { ...prev };
  for (const [q, a] of Object.entries(answers)) flat[q] = Array.isArray(a) ? a.join(", ") : a;
  return { ...base, answers: flat };
}
