import { splitMailboxes } from "../core/mail-header.ts";
import type { GmailMessage } from "./gmail.ts";

/**
 * Who a reply goes to (plan 2026-11-14-1134, KTD4 and KTD9; plan 2026-11-14-1530): Gmail's reply and reply all read
 * from a thread's newest message, and a Slack thread id as its conversation and thread. Kept apart from the proposals
 * so the readers in mod/account-ops/ and the send in mod/outside-threads.ts share them without a cycle.
 */

/** A Gmail message's header by name, any case; "" when it has none. */
export const headerOf = (m: GmailMessage | undefined, name: string): string =>
  m?.payload?.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

/** An address header's people, each as written ("Grace <grace@acme.com>") and by its bare address, lower case. */
function people(header: string): Array<{ text: string; address: string }> {
  return splitMailboxes(header).flatMap((text) => {
    // The address is the last <…>: a display name may hold angle brackets of its own, quoted.
    const address = ([...text.matchAll(/<([^<>]+)>/g)].at(-1)?.[1] ?? text).trim().toLowerCase();
    return address.includes("@") ? [{ text, address }] : [];
  });
}

/**
 * Who a reply to all of a message goes to (KTD9): its sender and everyone it was to, and everyone it copied, never the
 * person's own addresses and nobody twice. A message the person wrote themselves is answered to whom it went.
 */
export function replyAllOf(message: GmailMessage | undefined, own: readonly string[]): { to: string[]; cc: string[] } {
  const { mine, fromMe, sender } = whoWrote(message, own);
  const seen = new Set<string>();
  const keep = (list: Array<{ text: string; address: string }>) =>
    list.filter((p) => !mine.has(p.address) && !seen.has(p.address) && seen.add(p.address)).map((p) => p.text);
  const to = keep([...(fromMe ? [] : sender), ...people(headerOf(message, "To"))]);
  return { to, cc: keep(people(headerOf(message, "Cc"))) };
}

/**
 * Who a reply to all of `message` would reach now that the proposal did not name, and whom it named that it would no
 * longer reach (KTD4), by bare address in lower case, To and Cc together: a new display name or another order is not a
 * change. Both lists are empty when the people are the same, and the send at the end of the hold goes only then.
 */
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

/**
 * Who a reply to the sender alone goes to (plan 076): whom the message asks replies to go to (Reply-To), else its
 * sender; a message the person wrote themselves is answered to whom it went, as Gmail does.
 */
export function replyOf(message: GmailMessage | undefined, own: readonly string[]): { to: string[]; cc: string[] } {
  const { mine, fromMe, sender } = whoWrote(message, own);
  const seen = new Set<string>();
  const to = (fromMe ? people(headerOf(message, "To")) : sender).filter((p) => !mine.has(p.address) && !seen.has(p.address) && seen.add(p.address));
  return { to: to.map((p) => p.text), cc: [] };
}

/** The person's addresses, whether they wrote the message, and whom a reply to its writer goes to: its Reply-To, else its From. */
function whoWrote(message: GmailMessage | undefined, own: readonly string[]) {
  const mine = new Set(own.map((a) => a.toLowerCase()));
  const from = people(headerOf(message, "From"));
  const fromMe = from.length > 0 && from.every((p) => mine.has(p.address));
  const replyTo = people(headerOf(message, "Reply-To"));
  return { mine, fromMe, sender: replyTo.length ? replyTo : from };
}

/** People as bare addresses in lower case, each once, in their order: what a check compares and an agent is told. */
export const bareAddresses = (list: readonly string[]): string[] => [...new Set(list.flatMap((t) => people(t).map((p) => p.address)))];

/**
 * The message a reply answers: the newest in the thread by Gmail's time that is not one of the person's own drafts, so
 * an unsent draft never sets who the reply goes to or what it replies to (KTD9).
 */
export function replyTarget(messages: readonly GmailMessage[]): GmailMessage | undefined {
  return messages
    .filter((m) => !m.labelIds.includes("DRAFT"))
    .sort((a, b) => Number(a.internalDate) - Number(b.internalDate))
    .at(-1);
}

/** A reply's subject: the message's own, with one "Re:" in front. */
export const replySubject = (subject: string): string => (/^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`.trim());

/** A Slack card's thread id as its place: a DM card's is its channel, an Activity card's `<channel>:<thread ts>`. */
export function slackPlace(threadId: string): { channel: string; ts: string | null } {
  const at = threadId.indexOf(":");
  return at < 0 ? { channel: threadId, ts: null } : { channel: threadId.slice(0, at), ts: threadId.slice(at + 1) };
}
