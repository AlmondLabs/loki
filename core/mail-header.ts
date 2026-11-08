import type { MailPerson } from "./frame-types.ts";

/** An address header's people, by name and bare address, lower case; a name in quotes keeps what is inside them. */
export function headerPeople(header: string): MailPerson[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angle = false;
  for (const ch of header) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "<") angle = true;
    else if (!quoted && ch === ">") angle = false;
    if (ch === "," && !quoted && !angle) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  return parts.flatMap((p) => {
    const text = p.replace(/\s+/g, " ").trim();
    const angled = [...text.matchAll(/<([^<>]+)>/g)].at(-1);
    const address = (angled?.[1] ?? text).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(address)) return [];
    const name = angled ? text.slice(0, angled.index).replace(/"/g, "").trim() : "";
    return [{ name: name.toLowerCase() === address ? "" : name, address }];
  });
}
