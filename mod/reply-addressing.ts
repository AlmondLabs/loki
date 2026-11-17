import { splitMailboxes } from "../core/mail-header.ts";
import type { GmailMessage } from "./gmail.ts";

export const headerOf = (m: GmailMessage | undefined, name: string): string =>
  m?.payload?.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

function people(header: string): Array<{ text: string; address: string }> {
  return splitMailboxes(header).flatMap((text) => {
    // The address is the last <…>: a display name may hold angle brackets of its own, quoted.
    const address = ([...text.matchAll(/<([^<>]+)>/g)].at(-1)?.[1] ?? text).trim().toLowerCase();
    return address.includes("@") ? [{ text, address }] : [];
  });
}

export function replyAllOf(message: GmailMessage | undefined, own: readonly string[]): { to: string[]; cc: string[] } {
  const { mine, fromMe, sender } = whoWrote(message, own);
  const seen = new Set<string>();
  const keep = (list: Array<{ text: string; address: string }>) =>
    list.filter((p) => !mine.has(p.address) && !seen.has(p.address) && seen.add(p.address)).map((p) => p.text);
  const to = keep([...(fromMe ? [] : sender), ...people(headerOf(message, "To"))]);
  return { to, cc: keep(people(headerOf(message, "Cc"))) };
}

export function peopleChange(
  message: GmailMessage | undefined,
  own: readonly string[],
  proposal: { to: readonly string[]; cc: readonly string[] },
): { added: string[]; removed: string[] } {
  const bare = (list: readonly string[]) => new Set(list.flatMap((t) => people(t).map((p) => p.address)));
  const { to, cc } = replyAllOf(message, own);
  const now = bare([...to, ...cc]);
  const was = bare([...proposal.to, ...proposal.cc]);
  return { added: [...now].filter((a) => !was.has(a)), removed: [...was].filter((a) => !now.has(a)) };
}

export function replyOf(message: GmailMessage | undefined, own: readonly string[]): { to: string[]; cc: string[] } {
  const { mine, fromMe, sender } = whoWrote(message, own);
  const seen = new Set<string>();
  const to = (fromMe ? people(headerOf(message, "To")) : sender).filter((p) => !mine.has(p.address) && !seen.has(p.address) && seen.add(p.address));
  return { to: to.map((p) => p.text), cc: [] };
}

function whoWrote(message: GmailMessage | undefined, own: readonly string[]) {
  const mine = new Set(own.map((a) => a.toLowerCase()));
  const from = people(headerOf(message, "From"));
  const fromMe = from.length > 0 && from.every((p) => mine.has(p.address));
  const replyTo = people(headerOf(message, "Reply-To"));
  return { mine, fromMe, sender: replyTo.length ? replyTo : from };
}

export const bareAddresses = (list: readonly string[]): string[] => [...new Set(list.flatMap((t) => people(t).map((p) => p.address)))];

export function replyTarget(messages: readonly GmailMessage[]): GmailMessage | undefined {
  return messages
    .filter((m) => !m.labelIds.includes("DRAFT"))
    .sort((a, b) => Number(a.internalDate) - Number(b.internalDate))
    .at(-1);
}

export const replySubject = (subject: string): string => (/^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`.trim());

export function slackPlace(threadId: string): { channel: string; ts: string | null } {
  const at = threadId.indexOf(":");
  return at < 0 ? { channel: threadId, ts: null } : { channel: threadId.slice(0, at), ts: threadId.slice(at + 1) };
}
