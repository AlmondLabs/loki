const REPLY_OPENER = /^On .{4,300}wrote:\s*$/s;
const ORIGINAL_MESSAGE = /^-{2,}\s*Original Message\s*-{2,}$/i;
const OUTLOOK_FROM = /^From: .+$/;
const OUTLOOK_SENT_OR_DATE = /^(Sent|Date): /;

const opensOutlookHeader = (line: string, next: string | undefined): boolean => OUTLOOK_FROM.test(line) && OUTLOOK_SENT_OR_DATE.test(next?.trim() ?? "");

export const FORWARD_OPENER = /^(?:-{2,}\s*Forwarded message\s*-{2,}|Begin forwarded message:)/i;

export function withoutQuoted(text: string): string {
  const lines = text.split("\n");
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const one = lines[i].trim();
    if (FORWARD_OPENER.test(one)) return text.trim();
    const two = i + 1 < lines.length ? `${one} ${lines[i + 1].trim()}` : one;
    if (REPLY_OPENER.test(one) || REPLY_OPENER.test(two) || ORIGINAL_MESSAGE.test(one) || opensOutlookHeader(one, lines[i + 1])) {
      cut = i;
      break;
    }
  }
  const kept = lines.slice(0, cut);
  while (kept.length && (kept.at(-1)?.trim() === "" || kept.at(-1)?.trimStart().startsWith(">"))) kept.pop();
  const out = kept.join("\n").trim();
  return out || text.trim();
}
