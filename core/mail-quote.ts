/**
 * The part of an email reply that is the writer's own (plan 068): mail clients copy the whole earlier thread under each
 * reply, and a card that already shows that thread needs only what is new. Pure, so the daemon and tests share it.
 */

/** Lines that open the copied history: "On Tue, 4 Nov 2026 at 10:02, Ada <ada@acme.com> wrote:", Outlook's header block. */
const OPENERS = [/^On .{4,300}wrote:\s*$/s, /^-{2,}\s*Original Message\s*-{2,}$/i, /^From: .+$/];

/** The line that opens a forwarded mail, in Gmail's and Apple Mail's words. */
export const FORWARD_OPENER = /^(?:-{2,}\s*Forwarded message\s*-{2,}|Begin forwarded message:)/i;

/**
 * A message's text without the earlier thread quoted under it: cut at the first line (or two joined lines, which some
 * clients wrap) that opens the copied history, then without any trailing `>` lines. A message that is only a quote, or
 * whose cut leaves nothing, keeps its whole text, so nothing a person wrote disappears. A forward is kept whole when
 * its opening line comes before any quoted history: the forwarded mail is what it was sent for, so it reads open.
 */
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
