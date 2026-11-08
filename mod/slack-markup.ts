import shortcodes from "emojibase-data/en/shortcodes/iamcal.json" with { type: "json" };
import type { SlackAttachment, SlackBlock, SlackSpan } from "../core/frame-types.ts";
import type { SlackMessage } from "./slack.ts";

/**
 * Slack's message markup read the way Slack draws it (plan 075): a message's text, or the layout blocks an app posted
 * instead, into blocks and spans the card draws, and what an app attached under it. Names, channels and the workspace's
 * own emoji are looked up through `SlackNames`, which the caller remembers across messages.
 */

/** What reading a message needs to know about its workspace; each answers null when it cannot tell. */
export interface SlackNames {
  person(user: string): Promise<string>;
  channel?(id: string): Promise<string | null>;
  /** A custom emoji's image, or the standard emoji's name it stands for (`alias:<name>`); null when there is none. */
  emoji?(name: string): string | null;
}

/** Slack's names for the standard emoji (`white_check_mark`), each to the emoji itself. */
const STANDARD = new Map<string, string>();
for (const [hex, names] of Object.entries(shortcodes as Record<string, string | string[]>)) {
  const points = hex.split("-").map((h) => Number.parseInt(h, 16));
  // A lone character from the older symbol ranges (❤, ☀) draws as text without the emoji variation selector.
  const char = String.fromCodePoint(...points) + (points.length === 1 && points[0] < 0x1f000 ? "️" : "");
  for (const name of typeof names === "string" ? [names] : names) STANDARD.set(name, char);
}

/** The emoji Slack's name stands for: a standard character, else the workspace's own image; null when neither. */
function emojiSpan(name: string, tone: string | undefined, names: SlackNames, depth = 0): SlackSpan | null {
  const own = names.emoji?.(name) ?? null;
  if (own?.startsWith("alias:") && depth < 3) return emojiSpan(own.slice("alias:".length), tone, names, depth + 1);
  if (own?.startsWith("https://")) return { kind: "emoji", text: `:${name}:`, image: own };
  const char = STANDARD.get(name);
  if (char === undefined) return null;
  // Skin tones 2–6 are the five modifiers from U+1F3FB, which follow the emoji in place of its selector.
  return { kind: "emoji", text: tone ? char.replace("️", "") + String.fromCodePoint(0x1f3fb + Number(tone) - 2) : char };
}

const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

type Style = Partial<Record<"bold" | "italic" | "strike", true>>;

// One pass finds the next piece of markup: a <…> entity, `code`, *bold*, _italic_, ~strike~ or an :emoji:. A style's
// markers sit next to a word on the inside and away from one on the outside, as Slack reads them; an entity may sit
// inside a style (`*<url|title>*`), so a link's own underscores never start italics.
const INLINE =
  /<([^<>]*)>|`([^`\n]+)`|(?<![\p{L}\p{N}*])\*(?=\S)((?:<[^<>]*>|[^*\n<])+?)(?<=\S)\*(?![\p{L}\p{N}*])|(?<![\p{L}\p{N}_])_(?=\S)((?:<[^<>]*>|[^_\n<])+?)(?<=\S)_(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}~])~(?=\S)((?:<[^<>]*>|[^~\n<])+?)(?<=\S)~(?![\p{L}\p{N}~])|:([a-z0-9_+'-]+):(?::skin-tone-([2-6]):)?/gu;

async function inline(text: string, names: SlackNames, style: Style, out: SlackSpan[]): Promise<void> {
  const plain = (t: string) => {
    if (!t) return;
    const last = out.at(-1);
    const same = last?.kind === "text" && !last.code && last.bold === style.bold && last.italic === style.italic && last.strike === style.strike;
    if (same) last.text += decode(t);
    else out.push({ kind: "text", text: decode(t), ...style });
  };
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    plain(text.slice(at, m.index));
    at = m.index + m[0].length;
    // A group that did not take part is undefined, which the match's own type does not say.
    const groups: ReadonlyArray<string | undefined> = m;
    const [whole = "", entity, code, bold, italic, strike, emoji, tone] = groups;
    if (entity !== undefined) out.push(await entitySpan(entity, names, style));
    else if (code !== undefined) out.push({ kind: "text", text: decode(code), code: true });
    else if (bold !== undefined) await inline(bold, names, { ...style, bold: true }, out);
    else if (italic !== undefined) await inline(italic, names, { ...style, italic: true }, out);
    else if (strike !== undefined) await inline(strike, names, { ...style, strike: true }, out);
    else if (emoji !== undefined) {
      const span = emojiSpan(emoji, tone, names);
      if (span) out.push(span);
      else plain(whole);
    }
  }
  plain(text.slice(at));
}

/** One `<…>` entity: a person, channel, group or @channel as a mention, a date by its fallback, else a link. */
async function entitySpan(inner: string, names: SlackNames, style: Style): Promise<SlackSpan> {
  const bar = inner.indexOf("|");
  const target = bar < 0 ? inner : inner.slice(0, bar);
  const label = bar < 0 ? "" : decode(inner.slice(bar + 1));
  if (target.startsWith("@")) return { kind: "mention", text: `@${label || (await names.person(target.slice(1)))}` };
  if (target.startsWith("#")) {
    const name = label || (await names.channel?.(target.slice(1))) || target.slice(1);
    return { kind: "mention", text: `#${name}` };
  }
  if (target.startsWith("!subteam^")) return { kind: "mention", text: label || "@group" };
  if (target.startsWith("!date^")) return { kind: "text", text: label, ...style };
  if (target.startsWith("!")) return { kind: "mention", text: `@${target.slice(1)}` };
  const url = decode(target);
  const { text, style: own } = labelStyle(label);
  return { kind: "link", text: text || url.replace(/^mailto:/, ""), url, ...style, ...own };
}

/**
 * A link label's own styles: apps such as Sentry write `<url|*TypeError*>`, which Slack draws as a bold link, so markers
 * around the whole label become the link's style rather than its words.
 */
function labelStyle(label: string): { text: string; style: Style } {
  const style: Style = {};
  const marks = { "*": "bold", _: "italic", "~": "strike" } as const;
  let text = label;
  for (let m = /^([*_~])(\S(?:.*\S)?)\1$/s.exec(text); m; m = /^([*_~])(\S(?:.*\S)?)\1$/s.exec(text)) {
    style[marks[m[1] as keyof typeof marks]] = true;
    text = m[2];
  }
  return { text, style };
}

/** Slack's markup as the card draws it: code blocks, `>` quotes and ordinary lines, each read for its spans. */
export async function slackBlocks(text: string, names: SlackNames): Promise<SlackBlock[]> {
  // Runs of ordinary or quoted lines are gathered first, then each run is read for its spans as one.
  const runs: Array<{ kind: SlackBlock["kind"]; raw: string }> = [];
  const lines = (chunk: string) => {
    for (const line of chunk.split("\n")) {
      const quoted = /^(?:&gt;|>) ?/.exec(line);
      const kind = quoted ? "quote" : "text";
      const body = quoted ? line.slice(quoted[0].length) : line;
      const last = runs.at(-1);
      if (last?.kind === kind) last.raw += `\n${body}`;
      else runs.push({ kind, raw: body });
    }
  };
  let at = 0;
  for (const m of text.matchAll(/```\n?([\s\S]*?)\n?```/g)) {
    lines(text.slice(at, m.index));
    runs.push({ kind: "code", raw: m[1] });
    at = m.index + m[0].length;
  }
  lines(text.slice(at));
  const out: SlackBlock[] = [];
  for (const run of runs) {
    if (run.kind === "code") {
      out.push({ kind: "code", spans: [{ kind: "text", text: decode(run.raw), code: true }] });
      continue;
    }
    const spans: SlackSpan[] = [];
    await inline(run.raw.replace(/^\n+|\n+$/g, ""), names, {}, spans);
    if (spans.length) out.push({ kind: run.kind, spans });
  }
  return out;
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Text in Slack's layout blocks, as markup; plain text is escaped so its `*` and `_` stay as typed. */
function blockText(t: unknown): string {
  const r = rec(t);
  const text = str(r.text);
  return r.type === "plain_text" ? text.replace(/[*_~`]/g, (c) => `​${c}​`).replace(/​/g, "") : text;
}

/**
 * The markup a message shows: an app's layout blocks (a header, sections, context) when it posted only those, since
 * its `text` is then a summary for notifications; else its text, which rich text blocks only repeat.
 */
export function messageMarkup(m: Pick<SlackMessage, "text" | "raw">): string {
  const blocks = list(m.raw.blocks).map(rec);
  if (blocks.length === 0 || blocks.some((b) => b.type === "rich_text")) return m.text;
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type === "header") out.push(`*${str(rec(b.text).text)}*`);
    else if (b.type === "section") {
      if (b.text) out.push(blockText(b.text));
      const fields = list(b.fields).map(blockText).filter(Boolean);
      if (fields.length) out.push(fields.join("\n"));
    } else if (b.type === "context") {
      const words = list(b.elements).map(blockText).filter(Boolean);
      if (words.length) out.push(words.join("  "));
    }
  }
  return out.length ? out.join("\n") : m.text;
}

/** The colour Slack draws an attachment's bar in, from its own three words or a hex code. */
function barColor(v: unknown): string | null {
  const c = str(v);
  const named: Record<string, string> = { good: "#2eb886", warning: "#daa038", danger: "#a30200" };
  if (named[c]) return named[c];
  return /^#?[0-9a-f]{6}$/i.test(c) ? (c.startsWith("#") ? c : `#${c}`) : null;
}

/** What an app attached to a message (plan 075), each with what Slack draws of it; one with nothing to show is left out. */
export async function slackAttachments(m: Pick<SlackMessage, "raw">, names: SlackNames): Promise<SlackAttachment[]> {
  const out: SlackAttachment[] = [];
  for (const a of list(m.raw.attachments).map(rec)) {
    const att: SlackAttachment = {};
    if (str(a.pretext)) att.pretext = await slackBlocks(str(a.pretext), names);
    const title = str(a.title);
    const link = str(a.title_link);
    if (title) att.title = link ? [{ kind: "link", text: decode(title), url: link }] : [{ kind: "text", text: decode(title), bold: true }];
    const body = str(a.text) || messageMarkup({ text: "", raw: { blocks: a.blocks } });
    if (body) att.body = await slackBlocks(body, names);
    const fields = [];
    for (const f of list(a.fields).map(rec))
      if (str(f.value) || str(f.title)) fields.push({ title: decode(str(f.title)), value: await slackBlocks(str(f.value), names) });
    if (fields.length) att.fields = fields;
    if (!att.title && !att.body && !att.fields && str(a.fallback)) att.body = await slackBlocks(str(a.fallback), names);
    const color = barColor(a.color);
    if (color) att.color = color;
    if (att.pretext || att.title || att.body || att.fields) out.push(att);
  }
  return out;
}

/** Blocks as plain text, for a hand-off and the phone: links with their address, emoji as characters, lines kept. */
export function blocksPlain(blocks: readonly SlackBlock[]): string {
  return blocks
    .map((b) => {
      const words = b.spans.map((s) => (s.kind === "link" && s.text !== s.url && !s.url.startsWith("mailto:") ? `${s.text} (${s.url})` : s.text)).join("");
      return b.kind === "quote" ? words.replace(/^/gm, "> ") : words;
    })
    .join("\n");
}

/** An attachment as plain text: its lead line, title, text and fields, a line each. */
function attachmentPlain(a: SlackAttachment): string {
  const lines: string[] = [];
  if (a.pretext) lines.push(blocksPlain(a.pretext));
  if (a.title) lines.push(blocksPlain([{ kind: "text", spans: a.title }]));
  if (a.body) lines.push(blocksPlain(a.body));
  for (const f of a.fields ?? []) lines.push(`${f.title}: ${blocksPlain(f.value)}`);
  return lines.join("\n");
}

/** A message read whole: its blocks, what an app attached, and both as plain text (plan 075). */
export async function readSlackMessage(
  m: Pick<SlackMessage, "text" | "raw">,
  names: SlackNames,
): Promise<{ body: SlackBlock[]; attachments: SlackAttachment[]; text: string }> {
  const [body, attachments] = await Promise.all([slackBlocks(messageMarkup(m), names), slackAttachments(m, names)]);
  const text = [blocksPlain(body), ...attachments.map(attachmentPlain)].filter(Boolean).join("\n").trim();
  return { body, attachments, text };
}
