import type { SlackBlock, SlackSpan } from "../core/frame-types.ts";
import { writeMentions } from "../core/mentions.ts";

export interface JiraHistoryItem {
  field: string;
  from: string | null;
  to: string | null;
}

export type JiraDocInline = { type: "text"; text: string } | { type: "hardBreak" } | { type: "mention"; attrs: { id: string; text: string } };

export interface JiraDoc {
  version: 1;
  type: "doc";
  content: Array<{ type: "paragraph"; content: JiraDocInline[] }>;
}

export interface JiraDocText {
  lines: string[];
  mentions: string[];
}

const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const list = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);

export interface JiraFileRef {
  name: string | null;
  type: string | null;
  url: string | null;
  width: number | null;
  height: number | null;
}

const pixels = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : null);

/** Jira's nodes that stand for a file: one in a picture or a group of files, and one inside a line of text. */
const isFile = (node: Record<string, unknown>) => node.type === "media" || node.type === "mediaInline";

const fileLine = (node: Record<string, unknown>) => `file: ${str(rec(node.attrs).alt) || "attachment"}`;

export function adfFiles(doc: unknown): JiraFileRef[] {
  const out: JiraFileRef[] = [];
  const walk = (value: unknown): void => {
    const node = rec(value);
    if (isFile(node)) {
      const attrs = rec(node.attrs);
      const url = str(attrs.url);
      out.push({
        name: str(attrs.alt) || null,
        type: str(attrs.type) || null,
        url: attrs.type === "external" && url.startsWith("https://") ? url : null,
        width: pixels(attrs.width),
        height: pixels(attrs.height),
      });
      return;
    }
    for (const child of list(node.content)) walk(child);
  };
  walk(doc);
  return out;
}

function linkOf(node: Record<string, unknown>): string {
  for (const mark of list(node.marks)) if (rec(mark).type === "link") return str(rec(rec(mark).attrs).href);
  return "";
}

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
      case "mediaInline":
        return `\n${fileLine(node)}\n`;
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
        inner.forEach((line, j) => out.push((j === 0 ? mark : " ".repeat(mark.length)) + line));
      });
      return;
    }
    if (node.type === "codeBlock") {
      out.push(...inline(node).split("\n"));
      return;
    }
    if (children.some((child) => Array.isArray(rec(child).content))) {
      for (const child of children) block(child, out);
      return;
    }
    for (const line of inline(node).split("\n")) if (line.trim()) out.push(line.trim());
  };

  block(doc, lines);
  return { lines, mentions };
}

type SpanStyle = Partial<Record<"bold" | "italic" | "strike", true>>;

type SpanLine = SlackSpan[];

const MARK_STYLE = new Map<string, keyof SpanStyle>([
  ["strong", "bold"],
  ["em", "italic"],
  ["strike", "strike"],
]);

function sameStyle(a: SlackSpan, b: SlackSpan): boolean {
  return a.kind === "text" && b.kind === "text" && !a.code && !b.code && a.bold === b.bold && a.italic === b.italic && a.strike === b.strike;
}

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

const visible = (spans: readonly SlackSpan[]) => spans.some((s) => s.kind !== "text" || s.text.trim() !== "");

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
      case "mediaInline":
        return [];
      default:
        return list(node.content).flatMap((child) => inline(child, style));
    }
  };

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

  const holdsBlocks = (node: Record<string, unknown>) => node.type !== "paragraph" && list(node.content).some((child) => Array.isArray(rec(child).content));

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

export function historyLines(items: readonly JiraHistoryItem[]): string[] {
  return items.map((item) => `${item.field}: ${oneLine(item.from)} → ${oneLine(item.to)}`);
}

export function textToAdf(text: string, mentions: ReadonlyArray<{ display: string; id: string | null }> = []): JiraDoc {
  const people = mentions.filter((m): m is { display: string; id: string } => m.id !== null);
  const content: JiraDoc["content"] = [];
  for (const part of text.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const inlines: JiraDocInline[] = [];
    for (const line of part.split("\n")) {
      if (!line.trim()) continue;
      if (inlines.length) inlines.push({ type: "hardBreak" });
      inlines.push(
        ...writeMentions<{ display: string; id: string }, JiraDocInline>(
          line,
          people,
          (t) => ({ type: "text", text: t }),
          (m) => ({ type: "mention", attrs: { id: m.id, text: `@${m.display}` } }),
        ),
      );
    }
    if (inlines.length) content.push({ type: "paragraph", content: inlines });
  }
  return { version: 1, type: "doc", content };
}
