/**
 * Whether an email is "direct to you" (plan 067, R5, KTD6): from a person, with the person in To or Cc. Gmail's
 * search only narrows what is fetched; this rule, read from the message's own headers, has the last word, so the
 * same mail gives the same answer every time and no model reads mail to decide.
 */

/** A message header, as Gmail and most mail parsers give it. */
export interface MailHeader {
  name: string;
  value: string;
}

/**
 * Senders that are machines by their name alone: no-reply and do-not-reply addresses, and bounce notices. The list is
 * kept short on purpose, since a name a person might use (notifications@, info@) would hide real mail; automated mail
 * from other addresses nearly always carries the list or auto-submitted headers checked below.
 */
const NO_REPLY = /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]daemon)(?:[-_.+].*)?$/i;

const PRECEDENCE_AUTOMATED = ["bulk", "list", "junk"];

/** A header's value by name, ignoring case as mail does; null when the message has none. */
function headerValue(headers: readonly MailHeader[], name: string): string | null {
  const lower = name.toLowerCase();
  return headers.find((x) => x.name.toLowerCase() === lower)?.value ?? null;
}

/** An address list split at the commas (and semicolons) that sit outside quotes and angle brackets. */
function splitAddresses(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angle = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "\\" && quoted) {
      current += c + (value[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === "<") angle = true;
    else if (!quoted && c === ">") angle = false;
    if (!quoted && !angle && (c === "," || c === ";")) {
      parts.push(current);
      current = "";
    } else current += c;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/**
 * The addresses in an address header (`Grace <grace@acme.com>, "Lovelace, Ada" <ada@acme.com>`), in lower case. The
 * address is what sits in angle brackets, or the bare part when there are none; a display name, quoted or not, is never
 * read as an address.
 */
export function addressesIn(value: string): string[] {
  const out: string[] = [];
  for (const part of splitAddresses(value)) {
    const bracketed = /<([^<>]*)>\s*$/.exec(part.replace(/"(?:[^"\\]|\\.)*"/g, '""'));
    const address = (bracketed ? bracketed[1] : part).trim().toLowerCase();
    if (address.includes("@")) out.push(address);
  }
  return out;
}

/**
 * Whether a message becomes a card: one of `ownAddresses` (the mailbox's address and its send-as aliases) is in To or
 * Cc, and nothing marks it as a mailing list, a newsletter or a machine (`List-Id`, `List-Unsubscribe`, `Precedence:
 * bulk|list|junk`, `Auto-Submitted` other than `no`, `X-Auto-Response-Suppress`, or a no-reply sender).
 */
export function isDirectMail(headers: readonly MailHeader[], ownAddresses: readonly string[]): boolean {
  const has = (name: string) => headerValue(headers, name) !== null;
  if (has("List-Id") || has("List-Unsubscribe") || has("X-Auto-Response-Suppress")) return false;
  const precedence = headerValue(headers, "Precedence")?.trim().toLowerCase();
  if (precedence && PRECEDENCE_AUTOMATED.includes(precedence)) return false;
  const autoSubmitted = headerValue(headers, "Auto-Submitted");
  if (autoSubmitted !== null && autoSubmitted.split(";")[0].trim().toLowerCase() !== "no") return false;
  const from = addressesIn(headerValue(headers, "From") ?? "")[0];
  if (!from || NO_REPLY.test(from.slice(0, from.lastIndexOf("@")))) return false;
  const own = new Set(ownAddresses.map((a) => a.trim().toLowerCase()));
  return [...addressesIn(headerValue(headers, "To") ?? ""), ...addressesIn(headerValue(headers, "Cc") ?? "")].some((a) => own.has(a));
}
