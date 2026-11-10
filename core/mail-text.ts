/**
 * Email bodies as plain text a card can show (plan 068): pure, so the daemon, hand-offs and tests share it. Mail is
 * written for an HTML renderer, so its source spacing (the indentation and line breaks of layout tables) means nothing;
 * a browser collapses it, and so does this.
 */

/** Elements that end a line where they open or close. */
const BLOCK = "p|div|table|tbody|thead|tfoot|h[1-6]|ul|ol|blockquote|section|article|header|footer|center|hr|pre";

/** The named entities mail uses most; any other `&name;` is left as written. */
const ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  zwnj: "",
  zwj: "",
};

/** `&…;` entities decoded: named ones from the table, and decimal and hex character references. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith("#")) {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/**
 * Plain text tidied for reading: no invisible characters, each line's spacing collapsed and trimmed, and at most one
 * blank line between paragraphs. Mail's own plain parts are often generated from its HTML and carry the same spacing.
 */
export function tidyMail(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[   ]/g, " ")
    .replace(/[​-‍⁠﻿͏­]/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Elements whose whole content is no part of the text. */
const UNSEEN = /^<(head|style|script|title|noscript)\b/i;
/** Preheaders: a line of text hidden from the reader, written for the inbox list's preview. */
const HIDDEN = /^<(span|div|p|td)\b[^>]*style\s*=\s*["'][^"']*display\s*:\s*none[^"']*["']/i;
/** The longest opening tag read for a hidden style; a longer one is some generator's data, and is kept as a tag. */
const HIDDEN_TAG_MAX = 2000;

/**
 * Mail's HTML without what a browser never shows: comments, the content of `<head>`, `<style>`, `<script>` and the
 * like, and hidden preheaders. One pass from the start, so its time grows with the mail's length and no faster: mail
 * comes from strangers, and a pattern that looks ahead for each closing tag takes minutes on a few hundred kilobytes
 * of openers that never close. As in a browser, a comment or a tag that never ends hides the rest; an element that
 * never closes hides nothing.
 */
function shownHtml(html: string): string {
  const out: string[] = [];
  /** Elements with no closing tag from here on, so the search for one is made once. */
  const unclosed = new Set<string>();
  let at = 0;
  while (at < html.length) {
    const open = html.indexOf("<", at);
    if (open < 0) break;
    out.push(html.slice(at, open));
    if (html.startsWith("<!--", open)) {
      const end = html.indexOf("-->", open + 4);
      at = end < 0 ? html.length : end + 3;
      continue;
    }
    const close = html.indexOf(">", open);
    if (close < 0) {
      at = html.length;
      break;
    }
    const tag = html.slice(open, close + 1);
    at = close + 1;
    const name = (UNSEEN.exec(tag) ?? (tag.length <= HIDDEN_TAG_MAX ? HIDDEN.exec(tag) : null))?.[1]?.toLowerCase();
    if (name === undefined || unclosed.has(name)) {
      out.push(tag);
      continue;
    }
    const closing = new RegExp(`</${name}\\s*>`, "gi");
    closing.lastIndex = at;
    const end = closing.exec(html);
    if (end) at = end.index + end[0].length;
    else {
      unclosed.add(name);
      out.push(tag);
    }
  }
  out.push(html.slice(at));
  return out.join("");
}

/**
 * HTML mail as plain text, the way a browser lays it out: source whitespace collapsed, a line break at each block and
 * `<br>`, list items as bullets, table cells side by side, hidden preheader text and comments dropped, and entities
 * decoded; then tidied. Links keep their text only, as a mail client shows them.
 */
export function htmlToText(html: string): string {
  const text = shownHtml(html)
    .replace(/\s+/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(new RegExp(`</?(?:${BLOCK})\\b[^>]*>`, "gi"), "\n")
    // A table row ends one line; its cells sit side by side on it.
    .replace(/<\/tr\s*>/gi, "\n")
    .replace(/<\/(td|th)\s*>/gi, " ")
    .replace(/<[^>]*>/g, "");
  return tidyMail(decodeEntities(text));
}
