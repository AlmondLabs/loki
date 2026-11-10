import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FORWARD_OPENER } from "../../../core/mail-quote.ts";
import { openExternal } from "./env";

/**
 * A mail drawn as its sender wrote it: the HTML part in a sandboxed frame, so the layout, the images and the links
 * look as they do in a mail client. The frame runs no script and submits no form (its sandbox allows neither), and
 * its own policy lets it load only images, styles and fonts; a link opens in the person's browser, never in loki.
 * The frame is a document of loki's own origin with scripts off, so loki can size it to its content and catch clicks.
 */

/** Elements whose content never belongs in a drawn mail: scripts and anything that embeds or navigates on its own. */
const DROPPED = ["script", "noscript", "iframe", "frameset", "object", "applet"];

/**
 * Elements of the same kind that have no end tag. Each is taken out as its one tag: matched like those above, an
 * unclosed `<base>` took the rest of the mail with it.
 */
const DROPPED_VOID = ["frame", "embed", "base", "link"];

/**
 * The policy the mail's frame runs under: nothing but images, inline and linked styles, and fonts, so a mail cannot
 * call out to the network any other way. Remote images load, as the person chose on 2026-11-05: a sender can tell the
 * mail was opened.
 */
export const MAIL_POLICY = "default-src 'none'; img-src https: http: data: cid:; style-src 'unsafe-inline' https:; font-src https: data:";

/**
 * The frame's own look: a light page as mail is designed for, in the system's light page colours (loki's tokens do not
 * reach inside the frame).
 */
const MAIL_STYLE = [
  "html{color-scheme:light}",
  "body{margin:0;padding:12px 14px;background:Canvas;color:CanvasText;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;overflow-wrap:anywhere}",
  "img{max-width:100%;height:auto}",
  "table{max-width:100%}",
  "a{color:LinkText}",
].join("");

/** Hides the quoted thread under a reply until the person opens it with "•••". */
const QUOTE_HIDDEN = ".gmail_quote,blockquote[type=cite],.yahoo_quoted{display:none}";

/** Where a quoted thread or forwarded mail starts in a body: Gmail's and Yahoo's classes, Apple Mail's cite. */
const QUOTE_START = /<[a-z]+\b[^>]*(?:class\s*=\s*["'][^"']*\b(?:gmail_quote|yahoo_quoted)\b|type\s*=\s*["']?cite\b)/i;

/** A piece of HTML as its words: no tags, no styles, no invisible spaces. */
function wordsOf(html: string): string {
  return html
    .replace(/<(style|title)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:nbsp|zwnj);|&#(?:x?a0|0*160|x?200b|0*8203);/gi, " ")
    .trim();
}

/**
 * Whether a body's quote folds behind "•••": only the earlier thread under a reply that has text or an image of its
 * own above it. Gmail wraps a forward in the same class as a reply's history, but the forwarded mail is what it was
 * sent for, so it reads open, as Gmail shows it; and a mail that is all quote shows it, so a page is never empty. The
 * text view treats forwards and bare quotes the same way (`withoutQuoted`).
 */
export function quoteFolds(body: string): boolean {
  const at = body.search(QUOTE_START);
  if (at < 0) return false;
  const own = body.slice(0, at);
  if (!/<img\b/i.test(own) && wordsOf(own) === "") return false;
  return !FORWARD_OPENER.test(wordsOf(body.slice(at, at + 2000)));
}

/** The text between `<body…>` and `</body>`, or the whole of it when the mail has no body element. */
function bodyOf(html: string): string {
  const open = /<body\b[^>]*>/i.exec(html);
  const from = open ? open.index + open[0].length : 0;
  const close = html.search(/<\/body\s*>/i);
  return html.slice(from, close >= from ? close : html.length);
}

/** The `<style>` blocks in the mail's head, which carry most of its layout. */
function stylesOf(html: string): string {
  const head = /<head\b[^>]*>([\s\S]*?)<\/head\s*>/i.exec(html)?.[1] ?? "";
  return [...head.matchAll(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi)].map((m) => m[0]).join("");
}

/**
 * A mail's styles with their dark-mode rules turned off. The frame is a light page, as Gmail draws mail, but the Mac's
 * webview answers `prefers-color-scheme: dark` inside it when the Mac is dark, so a mail that brings its own dark rules
 * (Google Calendar's invites do) drew pale text on its white page. An unknown value makes the query match nothing.
 */
export function darkRulesOff(css: string): string {
  return css.replace(/prefers-color-scheme\s*:\s*dark/gi, "prefers-color-scheme: loki-light-page");
}

/**
 * The frame's document for a mail: its head's styles and its body, its quoted thread folded unless `quoteOpen`, with scripts, embedded frames and objects, base
 * and refresh tags taken out, under MAIL_POLICY, opening links in a new window. The sandbox already stops scripts;
 * taking them out keeps their text from showing and keeps the document small.
 */
export function mailDocument(html: string, quoteOpen = false): string {
  let body = darkRulesOff(bodyOf(html));
  for (const name of DROPPED) body = body.replace(new RegExp(`<${name}\\b[\\s\\S]*?(?:<\\/${name}\\s*>|\\/>|$)`, "gi"), "");
  for (const name of DROPPED_VOID) body = body.replace(new RegExp(`<${name}\\b[^>]*>`, "gi"), "");
  body = body.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi, "");
  return [
    "<!doctype html><html><head>",
    `<meta http-equiv="Content-Security-Policy" content="${MAIL_POLICY}">`,
    '<meta charset="utf-8"><base target="_blank">',
    `<style>${MAIL_STYLE}${quoteFolds(body) && !quoteOpen ? QUOTE_HIDDEN : ""}</style>`,
    darkRulesOff(stylesOf(html)).replace(/<\/?script\b[^>]*>/gi, ""),
    "</head><body>",
    body,
    "</body></html>",
  ].join("");
}

/** Whether a link may leave for the person's browser: the web and mail, nothing that runs or reads files. */
export function openableHref(href: string): boolean {
  return /^(?:https?:|mailto:)/i.test(href.trim());
}

/**
 * A mail's HTML in its frame, as tall as its content, its links opened in the person's browser. A reply's quoted thread
 * folds behind "•••" under the frame, as in Gmail; opening it redraws the frame with the quote shown.
 */
export function MailHtml({ html, title }: { html: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const folds = useMemo(() => quoteFolds(bodyOf(html)), [html]);
  const doc = useMemo(() => mailDocument(html, quoteOpen), [html, quoteOpen]);
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    let observer: ResizeObserver | null = null;
    const fit = () => {
      const page = el.contentDocument?.documentElement;
      if (page) setHeight(Math.max(40, Math.ceil(page.scrollHeight)));
    };
    const click = (e: MouseEvent) => {
      // The click comes from the frame's own document, whose elements are the frame's Element, not this page's.
      const inside = el.contentDocument?.defaultView;
      const target = inside && e.target instanceof inside.Element ? e.target.closest("a[href]") : null;
      if (!target) return;
      // Nothing navigates inside the frame: a web or mail link goes to the browser, anything else stays put.
      e.preventDefault();
      const href = target.getAttribute("href") ?? "";
      if (openableHref(href)) openExternal(href);
    };
    const loaded = () => {
      const page = el.contentDocument;
      if (!page) return;
      fit();
      page.addEventListener("click", click);
      // Images arrive after the first layout; the frame grows with them.
      observer = new ResizeObserver(fit);
      observer.observe(page.documentElement);
    };
    el.addEventListener("load", loaded);
    if (el.contentDocument?.readyState === "complete") loaded();
    return () => {
      el.removeEventListener("load", loaded);
      el.contentDocument?.removeEventListener("click", click);
      observer?.disconnect();
    };
  }, [doc]);
  const page = (
    <iframe
      ref={frame}
      className="loki-mail-html"
      // Named for screen readers by aria-label rather than title, which the Mac shows as a tooltip over the whole mail.
      aria-label={title}
      // No allow-scripts: nothing in the mail runs. Same origin with scripts off lets loki size the frame and catch clicks.
      // allow-popups is for the Mac's webview, which runs no listener of loki's inside a frame without scripts: there a
      // link asks for a new window (base target _blank), and the shell sends its address to the browser instead.
      sandbox="allow-same-origin allow-popups"
      srcDoc={doc}
      style={{ height }}
    />
  );
  if (!folds) return page;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {page}
      <button
        type="button"
        className="loki-mail-quote-toggle"
        aria-expanded={quoteOpen}
        aria-label={quoteOpen ? "hide the earlier mail" : "show the earlier mail"}
        title={quoteOpen ? "hide the earlier mail quoted under this one" : "show the earlier mail quoted under this one"}
        onClick={() => setQuoteOpen(!quoteOpen)}
      >
        •••
      </button>
    </div>
  );
}

/**
 * The web addresses in plain text, as text and links in turn, so a plain mail's links can be clicked too; `at` is where
 * each part starts in the text, which names it while the text stays the same.
 */
export function linkParts(text: string): Array<{ at: number; text: string; href: string | null }> {
  const parts: Array<{ at: number; text: string; href: string | null }> = [];
  let at = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'\])]+/gi)) {
    // A sentence's full stop or comma after an address is not part of it.
    const url = m[0].replace(/[.,;:!?]+$/, "");
    if (m.index > at) parts.push({ at, text: text.slice(at, m.index), href: null });
    parts.push({ at: m.index, text: url, href: url });
    at = m.index + url.length;
  }
  if (at < text.length) parts.push({ at, text: text.slice(at), href: null });
  return parts;
}

/** Plain text with its web addresses as links that open in the person's browser. */
export function LinkedText({ text }: { text: string }): ReactNode {
  return linkParts(text).map((p) =>
    p.href ? (
      <a
        key={p.at}
        className="loki-mail-link"
        href={p.href}
        onClick={(e) => {
          e.preventDefault();
          if (p.href) openExternal(p.href);
        }}
      >
        {p.text}
      </a>
    ) : (
      <Fragment key={p.at}>{p.text}</Fragment>
    ),
  );
}
