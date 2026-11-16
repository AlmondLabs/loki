const BLOCK = "p|div|table|tbody|thead|tfoot|h[1-6]|ul|ol|blockquote|section|article|header|footer|center|hr|pre";

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

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith("#")) {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

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

const UNSEEN = /^<(head|style|script|title|noscript)\b/i;
const HIDDEN = /^<(span|div|p|td)\b[^>]*style\s*=\s*["'][^"']*display\s*:\s*none[^"']*["']/i;
const HIDDEN_TAG_MAX = 2000;

function shownHtml(html: string): string {
  const out: string[] = [];
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

export function htmlToText(html: string): string {
  const text = shownHtml(html)
    .replace(/\s+/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(new RegExp(`</?(?:${BLOCK})\\b[^>]*>`, "gi"), "\n")
    .replace(/<\/tr\s*>/gi, "\n")
    .replace(/<\/(td|th)\s*>/gi, " ")
    .replace(/<[^>]*>/g, "");
  return tidyMail(decodeEntities(text));
}
