/**
 * Mentions in a reply's text (plan 2026-11-14-1530, KTD3): a mention is a person loki resolved and stored, shown in the
 * text as `@Full Name`. Only a stored mention whose `@display` is still in the text counts; any other `@word` is text,
 * so a stranger's `@handle` that an agent quotes, `@channel` or an address never notifies anyone.
 */

/** What finding a mention in text needs of it: the name it is shown by. */
export interface Mentioned {
  display: string;
}

/** One place a stored mention stands in text: where `@display` starts and ends, and which mention it is. */
export interface MentionSpan<T extends Mentioned> {
  start: number;
  end: number;
  mention: T;
}

/** Whether the character after a mention ends it: the text's end, or anything but a letter, digit or underscore. */
const endsName = (text: string, at: number): boolean => at >= text.length || !/[\p{L}\p{N}_]/u.test(text.charAt(at));
/** Whether the character before an `@` lets it start a mention: the text's start, or anything but a letter or digit. */
const startsName = (text: string, at: number): boolean => at === 0 || !/[\p{L}\p{N}_.]/u.test(text.charAt(at - 1));

/**
 * Every place a stored mention stands in `text` as `@display`, in order: whole names only, the longer name first where
 * two begin alike ("@Grace Lee" over "@Grace"), and none inside another. Names match in any case.
 */
export function mentionSpans<T extends Mentioned>(text: string, mentions: readonly T[]): Array<MentionSpan<T>> {
  const named = [...mentions].filter((m) => m.display.trim()).sort((a, b) => b.display.length - a.display.length);
  const lower = text.toLowerCase();
  const spans: Array<MentionSpan<T>> = [];
  for (let at = lower.indexOf("@"); at >= 0; at = lower.indexOf("@", at + 1)) {
    if (!startsName(text, at)) continue;
    const mention = named.find((m) => lower.startsWith(m.display.toLowerCase(), at + 1) && endsName(text, at + 1 + m.display.length));
    if (!mention) continue;
    const end = at + 1 + mention.display.length;
    spans.push({ start: at, end, mention });
    at = end - 1;
  }
  return spans;
}

/** The stored mentions still in `text`, each once, in the order the list has them: what a Send writes (KTD6). */
export function liveMentions<T extends Mentioned>(text: string, mentions: readonly T[]): T[] {
  const live = new Set(mentionSpans(text, mentions).map((s) => s.mention));
  return mentions.filter((m) => live.has(m));
}

/**
 * The mentions with only the last of any that share a name, in any case. The text tells mentions apart by `@display`
 * alone, so when the person picks someone whose name an earlier pick or the agent's mention already has, the later
 * pick is the one they mean: two colleagues called Sam would otherwise leave every `@Sam` with whoever came first.
 */
export function lastByName<T extends Mentioned>(mentions: readonly T[]): T[] {
  return mentions.filter((m, i) => !mentions.slice(i + 1).some((n) => n.display.toLowerCase() === m.display.toLowerCase()));
}

/**
 * `text` with each live mention written by `mention` and every other stretch by `plain`: how a service's own markup is
 * made from the stored mentions (Slack's `<@U…>`, a Jira document's mention node) and nothing else.
 */
export function writeMentions<T extends Mentioned, R>(text: string, mentions: readonly T[], plain: (text: string) => R, mention: (m: T) => R): R[] {
  const out: R[] = [];
  let at = 0;
  for (const s of mentionSpans(text, mentions)) {
    if (s.start > at) out.push(plain(text.slice(at, s.start)));
    out.push(mention(s.mention));
    at = s.end;
  }
  if (at < text.length) out.push(plain(text.slice(at)));
  return out;
}
