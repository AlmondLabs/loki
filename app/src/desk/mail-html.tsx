import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { openExternal } from "./env";

/**
 * A mail drawn as its sender wrote it: the HTML part in a sandboxed frame, so the layout, the images and the links
 * look as they do in a mail client. The frame runs no script and submits no form (its sandbox allows neither), and
 * its own policy lets it load only images, styles and fonts; a link opens in the person's browser, never in loki.
 * The frame is a document of loki's own origin with scripts off, so loki can size it to its content and catch clicks.
 */

/** Elements whose content never belongs in a drawn mail: scripts and anything that embeds or navigates on its own. */
const DROPPED = ["script", "noscript", "iframe", "frame", "frameset", "object", "embed", "applet", "base", "link[rel=import]"];

/**
 * The policy the mail's frame runs under: nothing but images, inline and linked styles, and fonts, so a mail cannot
 * call out to the network any other way. Remote images load, as the person chose on 2026-11-05: a sender can tell the
 * mail was opened.
 */
export const MAIL_POLICY = "default-src 'none'; img-src https: http: data: cid:; style-src 'unsafe-inline' https:; font-src https: data:";

/**
 * The frame's own look: a light page as mail is designed for, in the system's light page colours (loki's tokens do not
 * reach inside the frame), and the quoted thread under a reply hidden as the text view does.
 */
const MAIL_STYLE = [
  "html{color-scheme:light}",
  "body{margin:0;padding:12px 14px;background:Canvas;color:CanvasText;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;overflow-wrap:anywhere}",
  "img{max-width:100%;height:auto}",
  "table{max-width:100%}",
  "a{color:LinkText}",
  ".gmail_quote,blockquote[type=cite],.yahoo_quoted{display:none}",
].join("");

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
 * The frame's document for a mail: its head's styles and its body, with scripts, embedded frames and objects, base
 * and refresh tags taken out, under MAIL_POLICY, opening links in a new window. The sandbox already stops scripts;
 * taking them out keeps their text from showing and keeps the document small.
 */
export function mailDocument(html: string): string {
  let body = bodyOf(html);
  for (const tag of DROPPED) {
    const name = tag.replace(/\[.*$/, "");
    body = body.replace(new RegExp(`<${name}\\b[\\s\\S]*?(?:<\\/${name}\\s*>|\\/>|$)`, "gi"), "");
  }
  body = body.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi, "");
  return [
    "<!doctype html><html><head>",
    `<meta http-equiv="Content-Security-Policy" content="${MAIL_POLICY}">`,
    '<meta charset="utf-8"><base target="_blank">',
    `<style>${MAIL_STYLE}</style>`,
    stylesOf(html).replace(/<\/?script\b[^>]*>/gi, ""),
    "</head><body>",
    body,
    "</body></html>",
  ].join("");
}

/** Whether a link may leave for the person's browser: the web and mail, nothing that runs or reads files. */
export function openableHref(href: string): boolean {
  return /^(?:https?:|mailto:)/i.test(href.trim());
}

/** A mail's HTML in its frame, as tall as its content, its links opened in the person's browser. */
export function MailHtml({ html, title }: { html: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);
  const doc = useMemo(() => mailDocument(html), [html]);
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
  return (
    <iframe
      ref={frame}
      className="loki-mail-html"
      title={title}
      // No allow-scripts: nothing in the mail runs. Same origin with scripts off lets loki size the frame and catch clicks.
      // allow-popups is for the Mac's webview, which runs no listener of loki's inside a frame without scripts: there a
      // link asks for a new window (base target _blank), and the shell sends its address to the browser instead.
      sandbox="allow-same-origin allow-popups"
      srcDoc={doc}
      style={{ height }}
    />
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
