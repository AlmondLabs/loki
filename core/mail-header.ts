import type { MailPerson } from "./frame-types.ts";

/**
 * An address header's entries, split at the commas between them. A comma inside a quoted name or inside `<…>` splits
 * nothing, and inside quotes a backslash takes the next character as it is, so `"O\\"Brien, Pat" <pat@x.com>` is one
 * entry: a sender chooses their own display name, and one that closed its quote early would otherwise add a recipient.
 */
export function splitMailboxes(header: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angle = false;
  let escaped = false;
  for (const ch of header) {
    if (escaped) escaped = false;
    else if (quoted && ch === "\\") escaped = true;
    else if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "<") angle = true;
    else if (!quoted && ch === ">") angle = false;
    if (ch === "," && !quoted && !angle) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
}

/** A display name as its words: the quotes around it dropped, and each backslash pair read as its second character. */
const unquoted = (name: string): string => name.replace(/\\(.)|"/g, (_, ch: string | undefined) => ch ?? "").trim();

/** An address header's people as written: each name without its quotes, each address in its own case. */
export function headerMailboxes(header: string): MailPerson[] {
  return splitMailboxes(header).flatMap((text) => {
    // The address is the last <…>: a display name may hold angle brackets of its own, quoted.
    const angled = [...text.matchAll(/<([^<>]+)>/g)].at(-1);
    const address = (angled?.[1] ?? text).trim();
    if (!/^[^\s@]+@[^\s@]+$/.test(address)) return [];
    const name = angled ? unquoted(text.slice(0, angled.index)) : "";
    return [{ name: name.toLowerCase() === address.toLowerCase() ? "" : name, address }];
  });
}

/** An address header's people, by name and bare address, lower case; a name in quotes keeps what is inside them. */
export function headerPeople(header: string): MailPerson[] {
  return headerMailboxes(header).map((p) => ({ name: p.name, address: p.address.toLowerCase() }));
}
