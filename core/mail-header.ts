import type { MailPerson } from "./frame-types.ts";

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

const unquoted = (name: string): string => name.replace(/\\(.)|"/g, (_, ch: string | undefined) => ch ?? "").trim();

export function headerMailboxes(header: string): MailPerson[] {
  return splitMailboxes(header).flatMap((text) => {
    const angled = [...text.matchAll(/<([^<>]+)>/g)].at(-1);
    const address = (angled?.[1] ?? text).trim();
    if (!/^[^\s@]+@[^\s@]+$/.test(address)) return [];
    const name = angled ? unquoted(text.slice(0, angled.index)) : "";
    return [{ name: name.toLowerCase() === address.toLowerCase() ? "" : name, address }];
  });
}

export function headerPeople(header: string): MailPerson[] {
  return headerMailboxes(header).map((p) => ({ name: p.name, address: p.address.toLowerCase() }));
}
