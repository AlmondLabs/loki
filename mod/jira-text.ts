/**
 * Jira's text, both ways (plan 2026-11-10-1451, KTD15). Jira keeps a comment as a document of nested nodes (the
 * Atlassian Document Format) and a history entry as a list of changed fields; a card shows plain lines, and the
 * person's comment is typed as plain text. Every conversion lives here, as pure functions, so the card, the hand-off
 * and the tools read a ticket the same way.
 */

/** One changed field of a history entry, by the values Jira shows; null where the field was or became empty. */
export interface JiraHistoryItem {
  field: string;
  from: string | null;
  to: string | null;
}

/** A piece of a paragraph in a document loki writes: text, or a line break. */
export type JiraDocInline = { type: "text"; text: string } | { type: "hardBreak" };

/** A document as loki writes one: paragraphs of text and line breaks, the plainest form Jira accepts. */
export interface JiraDoc {
  version: 1;
  type: "doc";
  content: Array<{ type: "paragraph"; content: JiraDocInline[] }>;
}

/** A Jira document read as plain lines, and the account ids of the people it mentions. */
export interface JiraDocText {
  lines: string[];
  mentions: string[];
}

const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const list = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);

/** The address a text node links to, when it carries a link mark. */
function linkOf(node: Record<string, unknown>): string {
  for (const mark of list(node.marks)) if (rec(mark).type === "link") return str(rec(rec(mark).attrs).href);
  return "";
}

/**
 * A Jira document as plain lines, top to bottom: a line for each paragraph and each line break in it, list items with
 * their mark, code as written, a link as its text and address, and a mention as the person's name. A node type this
 * does not know is read for the text inside it, so a new kind of block never empties a comment. `mentions` lists each
 * mentioned account id once, so a caller can tell whether the person was mentioned.
 */
export function adfText(doc: unknown): JiraDocText {
  const lines: string[] = [];
  const mentions: string[] = [];

  const inline = (value: unknown): string => {
    const node = rec(value);
    const attrs = rec(node.attrs);
    switch (node.type) {
      case "text": {
        const text = str(node.text);
        const href = linkOf(node);
        return href && href !== text ? `${text} (${href})` : text;
      }
      case "hardBreak":
        return "\n";
      case "mention": {
        const id = str(attrs.id);
        if (id && !mentions.includes(id)) mentions.push(id);
        return str(attrs.text) || "@someone";
      }
      case "emoji":
        return str(attrs.text) || str(attrs.shortName);
      case "inlineCard":
      case "blockCard":
        return str(attrs.url);
      case "media":
        return "[attachment]";
      default:
        return list(node.content).map(inline).join("");
    }
  };

  const block = (value: unknown, out: string[]): void => {
    const node = rec(value);
    const children = list(node.content);
    if (node.type === "bulletList" || node.type === "orderedList") {
      const order = rec(node.attrs).order;
      const first = typeof order === "number" ? order : 1;
      children.forEach((item, i) => {
        const mark = node.type === "orderedList" ? `${first + i}. ` : "- ";
        const inner: string[] = [];
        block(item, inner);
        // Lines after an item's first, a nested list among them, sit under its text.
        inner.forEach((line, j) => out.push((j === 0 ? mark : " ".repeat(mark.length)) + line));
      });
      return;
    }
    if (node.type === "codeBlock") {
      out.push(...inline(node).split("\n"));
      return;
    }
    // A node holding other blocks is read block by block; one holding only text and marks is one block of lines.
    if (children.some((child) => Array.isArray(rec(child).content))) {
      for (const child of children) block(child, out);
      return;
    }
    for (const line of inline(node).split("\n")) if (line.trim()) out.push(line.trim());
  };

  block(doc, lines);
  return { lines, mentions };
}

/** A value on one line: Jira gives a description's whole text as the old and new value. */
const oneLine = (value: string | null): string => value?.replace(/\s+/g, " ").trim() || "none";

/** A history entry as lines, one for each changed field: the field, then its old and new values. */
export function historyLines(items: readonly JiraHistoryItem[]): string[] {
  return items.map((item) => `${item.field}: ${oneLine(item.from)} → ${oneLine(item.to)}`);
}

/**
 * The person's plain text as a Jira document: a paragraph for each run of lines, parted by blank lines, with a line
 * break for each single newline. Jira refuses an empty text node, so empty lines write nothing.
 */
export function textToAdf(text: string): JiraDoc {
  const content: JiraDoc["content"] = [];
  for (const part of text.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const inlines: JiraDocInline[] = [];
    for (const line of part.split("\n")) {
      if (!line.trim()) continue;
      if (inlines.length) inlines.push({ type: "hardBreak" });
      inlines.push({ type: "text", text: line });
    }
    if (inlines.length) content.push({ type: "paragraph", content: inlines });
  }
  return { version: 1, type: "doc", content };
}
