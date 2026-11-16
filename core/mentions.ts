export interface Mentioned {
  display: string;
}

export interface MentionSpan<T extends Mentioned> {
  start: number;
  end: number;
  mention: T;
}

const endsName = (text: string, at: number): boolean => at >= text.length || !/[\p{L}\p{N}_]/u.test(text.charAt(at));
const startsName = (text: string, at: number): boolean => at === 0 || !/[\p{L}\p{N}_.]/u.test(text.charAt(at - 1));

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

export function liveMentions<T extends Mentioned>(text: string, mentions: readonly T[]): T[] {
  const live = new Set(mentionSpans(text, mentions).map((s) => s.mention));
  return mentions.filter((m) => live.has(m));
}

export function lastByName<T extends Mentioned>(mentions: readonly T[]): T[] {
  return mentions.filter((m, i) => !mentions.slice(i + 1).some((n) => n.display.toLowerCase() === m.display.toLowerCase()));
}

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
