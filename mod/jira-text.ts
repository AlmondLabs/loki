import type { SlackBlock, SlackSpan } from "../core/frame-types.ts";

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

/** The styles a text node's marks give it that a Slack span can draw; underline, colour and the like are left plain. */
type SpanStyle = Partial<Record<"bold" | "italic" | "strike", true>>;

/** One line of a list or a quote, as spans, before the lines are joined with newlines. */
type SpanLine = SlackSpan[];

/** Jira's marks that a Slack span has a style for, by the style's name. */
const MARK_STYLE = new Map<string, keyof SpanStyle>([
  ["strong", "bold"],
  ["em", "italic"],
  ["strike", "strike"],
]);

/** Two plain text spans with the same styles draw as one, so a converted comment holds no needless splits. */
function sameStyle(a: SlackSpan, b: SlackSpan): boolean {
  return a.kind === "text" && b.kind === "text" && !a.code && !b.code && a.bold === b.bold && a.italic === b.italic && a.strike === b.strike;
}

/** Spans with neighbouring plain text of one style joined, and empty text left out. */
function joined(spans: readonly SlackSpan[]): SlackSpan[] {
  const out: SlackSpan[] = [];
  for (const span of spans) {
    if (span.kind === "text" && span.text === "") continue;
    const last = out.at(-1);
    if (last?.kind === "text" && sameStyle(last, span)) last.text += span.text;
    else out.push({ ...span });
  }
  return out;
}

/** Whether spans hold anything to see: a mention, a link, an emoji, or text that is not only blank. */
const visible = (spans: readonly SlackSpan[]) => spans.some((s) => s.kind !== "text" || s.text.trim() !== "");

/**
 * A Jira document as the blocks and spans the Slack card draws (plan 090, Decision 1): a paragraph is a block of
 * lines, a heading a bold one, a quote and a code block Slack's own, and a list a block of lines, each item after its
 * bullet or number and a list inside an item indented under it, since Slack's shape has no list. Bold, italics,
 * strikethrough and code marks style their text; a link is drawn by its label and keeps its address; a mention is
 * Slack's mention pill with the name Jira wrote; an emoji is its character. Anything the shape has no place for keeps
 * its words as `adfText` reads them, and an attachment reads "[attachment]".
 */
export function adfBlocks(doc: unknown): SlackBlock[] {
  const inline = (value: unknown, style: SpanStyle): SlackSpan[] => {
    const node = rec(value);
    const attrs = rec(node.attrs);
    switch (node.type) {
      case "text": {
        const text = str(node.text);
        const href = linkOf(node);
        const marks = list(node.marks).map((m) => str(rec(m).type));
        const own: SpanStyle = { ...style };
        for (const m of marks) {
          const key = MARK_STYLE.get(m);
          if (key) own[key] = true;
        }
        if (href) return [{ kind: "link", text, url: href, ...own }];
        return marks.includes("code") ? [{ kind: "text", text, code: true }] : [{ kind: "text", text, ...own }];
      }
      case "hardBreak":
        return [{ kind: "text", text: "\n" }];
      case "mention": {
        const name = str(attrs.text);
        return [{ kind: "mention", text: name ? (name.startsWith("@") ? name : `@${name}`) : "@someone" }];
      }
      case "emoji":
        return str(attrs.text) ? [{ kind: "emoji", text: str(attrs.text) }] : [{ kind: "text", text: str(attrs.shortName), ...style }];
      case "inlineCard":
      case "blockCard": {
        const url = str(attrs.url);
        return url ? [{ kind: "link", text: url, url }] : [];
      }
      case "media":
        return [{ kind: "text", text: "[attachment]", ...style }];
      default:
        return list(node.content).flatMap((child) => inline(child, style));
    }
  };

  /** A node's spans cut at its line breaks, each line kept only when it shows something. */
  const lines = (spans: readonly SlackSpan[]): SpanLine[] => {
    const out: SpanLine[] = [[]];
    for (const span of spans) {
      if (span.kind !== "text" || !span.text.includes("\n")) {
        out[out.length - 1].push(span);
        continue;
      }
      span.text.split("\n").forEach((part, i) => {
        if (i > 0) out.push([]);
        out[out.length - 1].push({ ...span, text: part });
      });
    }
    return out.filter(visible);
  };

  // A paragraph holds only text and marks, even a kind of inline node this does not know; another node holding nodes
  // that hold more (the document, a list item, a panel, a table) is read block by block.
  const holdsBlocks = (node: Record<string, unknown>) => node.type !== "paragraph" && list(node.content).some((child) => Array.isArray(rec(child).content));

  /** The lines of what sits in a list item or a quote. */
  const linesOf = (value: unknown): SpanLine[] => {
    const node = rec(value);
    if (node.type === "bulletList" || node.type === "orderedList") return listLines(node);
    if (node.type === "codeBlock")
      return adfText(node)
        .lines.filter((line) => line.trim())
        .map((text): SpanLine => [{ kind: "text", text, code: true }]);
    if (node.type === "heading") return lines(inline(node, { bold: true }));
    if (holdsBlocks(node)) return list(node.content).flatMap(linesOf);
    return lines(inline(node, {}));
  };

  /** A list as lines: each item's first line after its mark, the rest of it, a nested list among them, under its text. */
  const listLines = (node: Record<string, unknown>): SpanLine[] => {
    const order = rec(node.attrs).order;
    const first = typeof order === "number" ? order : 1;
    return list(node.content).flatMap((item, i) => {
      const mark = node.type === "orderedList" ? `${String(first + i)}. ` : "• ";
      return linesOf(item).map((line, j): SpanLine => [{ kind: "text", text: j === 0 ? mark : " ".repeat(mark.length) }, ...line]);
    });
  };

  const asOne = (ls: readonly SpanLine[]): SlackSpan[] => joined(ls.flatMap((l, i) => (i === 0 ? l : [{ kind: "text" as const, text: "\n" }, ...l])));

  const out: SlackBlock[] = [];
  const add = (kind: SlackBlock["kind"], spans: SlackSpan[]) => {
    if (visible(spans)) out.push({ kind, spans });
  };
  const block = (value: unknown): void => {
    const node = rec(value);
    if (node.type === "codeBlock") {
      const code = adfText(node).lines.join("\n");
      if (code.trim()) out.push({ kind: "code", spans: [{ kind: "text", text: code, code: true }] });
    } else if (node.type === "blockquote") add("quote", asOne(list(node.content).flatMap(linesOf)));
    else if (node.type === "bulletList" || node.type === "orderedList") add("text", asOne(listLines(node)));
    else if (node.type === "heading") add("text", asOne(lines(inline(node, { bold: true }))));
    else if (holdsBlocks(node)) for (const child of list(node.content)) block(child);
    else add("text", asOne(lines(inline(node, {}))));
  };
  block(doc);
  return out;
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
