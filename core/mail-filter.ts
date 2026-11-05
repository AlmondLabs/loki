/**
 * What kind of mail a message is, read from its own headers and labels so the same mail gives the same answer every
 * time and no model reads mail to decide. Plan 067 let only "direct to you" mail in (R5, KTD6); plan 069 lets every
 * unread inbox mail in and keeps these facts beside the person's moves instead.
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

/** Gmail's inbox tab for a message, from its labels; null for a mailbox that does not sort mail into tabs. */
export type MailCategory = "primary" | "updates" | "promotions" | "social" | "forums";

const CATEGORIES: Partial<Record<string, MailCategory>> = {
  CATEGORY_PERSONAL: "primary",
  CATEGORY_UPDATES: "updates",
  CATEGORY_PROMOTIONS: "promotions",
  CATEGORY_SOCIAL: "social",
  CATEGORY_FORUMS: "forums",
};

/**
 * What kind of mail a message is (plan 069): every unread mail in the inbox becomes a card, and these facts go with it
 * into the ledger of the person's moves, so what they do with each kind can be learned later. Nothing here keeps a
 * mail out.
 */
export interface MailTraits {
  /** One of the person's addresses (the mailbox's or a send-as alias) is in To or Cc. */
  to_you: boolean;
  /** A mailing list or newsletter: `List-Id`, `List-Unsubscribe`, or `Precedence: bulk|list`. */
  list: boolean;
  /** Sent by a machine: `Auto-Submitted` other than `no`, `X-Auto-Response-Suppress`, `Precedence: junk`, or a no-reply sender. */
  automated: boolean;
  /** Gmail's tab for it, from its labels. */
  category: MailCategory | null;
}

/** The traits of a message, from its headers, the person's own addresses and its Gmail labels. */
export function mailTraits(headers: readonly MailHeader[], ownAddresses: readonly string[], labelIds: readonly string[] = []): MailTraits {
  const has = (name: string) => headerValue(headers, name) !== null;
  const precedence = headerValue(headers, "Precedence")?.trim().toLowerCase() ?? null;
  const autoSubmitted = headerValue(headers, "Auto-Submitted");
  const from = addressesIn(headerValue(headers, "From") ?? "")[0];
  const own = new Set(ownAddresses.map((a) => a.trim().toLowerCase()));
  return {
    to_you: [...addressesIn(headerValue(headers, "To") ?? ""), ...addressesIn(headerValue(headers, "Cc") ?? "")].some((a) => own.has(a)),
    list: has("List-Id") || has("List-Unsubscribe") || precedence === "bulk" || precedence === "list",
    automated:
      has("X-Auto-Response-Suppress") ||
      precedence === "junk" ||
      (autoSubmitted !== null && autoSubmitted.split(";")[0].trim().toLowerCase() !== "no") ||
      !from ||
      NO_REPLY.test(from.slice(0, from.lastIndexOf("@"))),
    category: labelIds.map((l) => CATEGORIES[l]).find((c) => c !== undefined) ?? null,
  };
}

/** Traits as a file gives them back, or null when they are not traits (a record from before plan 069 has none). */
export function parseMailTraits(v: unknown): MailTraits | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.to_you !== "boolean" || typeof r.list !== "boolean" || typeof r.automated !== "boolean") return null;
  const category = Object.values(CATEGORIES).find((c) => c === r.category) ?? null;
  return { to_you: r.to_you, list: r.list, automated: r.automated, category };
}

/**
 * Whether a message is direct to the person: one of `ownAddresses` is in To or Cc, and nothing marks it as a mailing
 * list, a newsletter or a machine. It no longer decides what becomes a card (plan 069); the ledger keeps it as a fact.
 */
export function isDirectMail(headers: readonly MailHeader[], ownAddresses: readonly string[]): boolean {
  const t = mailTraits(headers, ownAddresses);
  return t.to_you && !t.list && !t.automated;
}
