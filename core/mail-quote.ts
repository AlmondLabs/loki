const OPENERS = [/^On .{4,300}wrote:\s*$/s, /^-{2,}\s*Original Message\s*-{2,}$/i, /^From: .+$/];

export const FORWARD_OPENER = /^(?:-{2,}\s*Forwarded message\s*-{2,}|Begin forwarded message:)/i;

export function withoutQuoted(text: string): string {
  const lines = text.split("\n");
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const one = lines[i].trim();
    if (FORWARD_OPENER.test(one)) return text.trim();
    const two = i + 1 < lines.length ? `${one} ${lines[i + 1].trim()}` : one;
    // Outlook's block is "From:" followed by "Sent:" or "Date:"; a lone "From:" line is the writer's own text.
    const outlook = OPENERS[2].test(one) && /^(Sent|Date): /.test(lines[i + 1]?.trim() ?? "");
    if (OPENERS[0].test(one) || OPENERS[0].test(two) || OPENERS[1].test(one) || outlook) {
      cut = i;
      break;
    }
  }
  const kept = lines.slice(0, cut);
  while (kept.length && (kept.at(-1)?.trim() === "" || kept.at(-1)?.trimStart().startsWith(">"))) kept.pop();
  const out = kept.join("\n").trim();
  return out || text.trim();
}
