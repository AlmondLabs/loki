export interface MailHeader {
  name: string;
  value: string;
}

const NO_REPLY = /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]daemon)(?:[-_.+].*)?$/i;

function headerValue(headers: readonly MailHeader[], name: string): string | null {
  const lower = name.toLowerCase();
  return headers.find((x) => x.name.toLowerCase() === lower)?.value ?? null;
}

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

export function addressesIn(value: string): string[] {
  const out: string[] = [];
  for (const part of splitAddresses(value)) {
    const bracketed = /<([^<>]*)>\s*$/.exec(part.replace(/"(?:[^"\\]|\\.)*"/g, '""'));
    const address = (bracketed ? bracketed[1] : part).trim().toLowerCase();
    if (address.includes("@")) out.push(address);
  }
  return out;
}

export type MailCategory = "primary" | "updates" | "promotions" | "social" | "forums";

const CATEGORIES: Partial<Record<string, MailCategory>> = {
  CATEGORY_PERSONAL: "primary",
  CATEGORY_UPDATES: "updates",
  CATEGORY_PROMOTIONS: "promotions",
  CATEGORY_SOCIAL: "social",
  CATEGORY_FORUMS: "forums",
};

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

export function parseMailTraits(v: unknown): MailTraits | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.to_you !== "boolean" || typeof r.list !== "boolean" || typeof r.automated !== "boolean") return null;
  const category = Object.values(CATEGORIES).find((c) => c === r.category) ?? null;
  return { to_you: r.to_you, list: r.list, automated: r.automated, category };
}

export function isDirectMail(headers: readonly MailHeader[], ownAddresses: readonly string[]): boolean {
  const t = mailTraits(headers, ownAddresses);
  return t.to_you && !t.list && !t.automated;
}
