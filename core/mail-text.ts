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

/**
 * HTML mail as plain text, the way a browser lays it out: source whitespace collapsed, a line break at each block and
 * `<br>`, list items as bullets, table cells side by side, hidden preheader text and comments dropped, and entities
 * decoded; then tidied. Links keep their text only, as a mail client shows them.
 */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(head|style|script|title|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    // Preheaders: a line of text hidden from the reader, written for the inbox list's preview.
    .replace(/<(span|div|p|td)\b[^>]*style\s*=\s*["'][^"']*display\s*:\s*none[^"']*["'][^>]*>[\s\S]*?<\/\1\s*>/gi, "")
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
