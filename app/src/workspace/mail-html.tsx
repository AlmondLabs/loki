import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { bodyOf, CID_SRC, cidOf, drawnBody } from "../../../core/mail-pictures.ts";
import { FORWARD_OPENER } from "../../../core/mail-quote.ts";
import { chatImageUrl, openExternal } from "./env";

export const MAIL_POLICY = "default-src 'none'; img-src https: http: data: cid:; style-src 'unsafe-inline' https:; font-src https: data:";

const MAIL_STYLE = [
  "html{color-scheme:light}",
  "body{margin:0;padding:12px 14px;background:Canvas;color:CanvasText;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;overflow-wrap:anywhere}",
  "img{max-width:100%;height:auto}",
  "table{max-width:100%}",
  "a{color:LinkText}",
].join("");

const QUOTE_HIDDEN = ".gmail_quote,blockquote[type=cite],.yahoo_quoted{display:none}";

const QUOTE_START = /<[a-z]+\b[^>]*(?:class\s*=\s*["'][^"']*\b(?:gmail_quote|yahoo_quoted)\b|type\s*=\s*["']?cite\b)/i;

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

function placeImages(body: string, images: Record<string, string>): string {
  return body.replace(CID_SRC, (whole, head: string, double: string | undefined, single: string | undefined, bare: string | undefined) => {
    const id = cidOf(double ?? single ?? bare ?? "");
    const url = Object.hasOwn(images, id) ? images[id] : undefined;
    if (url === undefined) return whole;
    const quote = double !== undefined ? '"' : single !== undefined ? "'" : "";
    return `${head}${quote}${url}${quote}`;
  });
}

export type ImageFetch = (name: string) => Promise<Blob>;

async function fetchChatImage(name: string): Promise<Blob> {
  const res = await fetch(chatImageUrl(name));
  if (!res.ok) throw new Error(`picture ${name}: ${res.status}`);
  return res.blob();
}

async function dataUrlOf(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return `data:${blob.type};base64,${btoa(binary)}`;
}

export async function inlineImages(names: Record<string, string>, fetchImage: ImageFetch = fetchChatImage): Promise<Record<string, string>> {
  const loaded = await Promise.all(
    Object.entries(names).map(([id, name]) =>
      fetchImage(name)
        .then(dataUrlOf)
        .then(
          (url) => [id, url] as const,
          () => null,
        ),
    ),
  );
  return Object.fromEntries(loaded.filter((entry) => entry !== null));
}

export function mailDocument(html: string, quoteOpen = false, images: Record<string, string> = {}): string {
  let body = darkRulesOff(drawnBody(html));
  body = body.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi, "");
  // Outside (HTML): a referrer rule in the mail would apply too, and could send the page's address, which in a browser
  // tab carries the daemon's token, to whoever hosts its images. The frame's own rule below is the only one kept.
  body = body.replace(/<meta\b[^>]*name\s*=\s*["']?referrer[^>]*>/gi, "").replace(/\sreferrerpolicy\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  body = placeImages(body, images);
  return [
    "<!doctype html><html><head>",
    `<meta http-equiv="Content-Security-Policy" content="${MAIL_POLICY}">`,
    '<meta charset="utf-8"><meta name="referrer" content="no-referrer"><base target="_blank">',
    `<style>${MAIL_STYLE}${quoteFolds(body) && !quoteOpen ? QUOTE_HIDDEN : ""}</style>`,
    darkRulesOff(stylesOf(html)).replace(/<\/?script\b[^>]*>/gi, ""),
    "</head><body>",
    body,
    "</body></html>",
  ].join("");
}

export function openableHref(href: string): boolean {
  return /^(?:https?:|mailto:)/i.test(href.trim());
}

export function MailHtml({ html, title, images }: { html: string; title: string; images?: Record<string, string> }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [placed, setPlaced] = useState<Partial<Record<string, { name: string; url: string }>>>({});
  useEffect(() => {
    if (!images) return;
    let current = true;
    void inlineImages(images).then((loaded) => {
      if (!current) return;
      setPlaced((before) => {
        const fresh = Object.entries(loaded).filter(([id, url]) => before[id]?.name !== images[id] || before[id]?.url !== url);
        if (!fresh.length) return before;
        return { ...before, ...Object.fromEntries(fresh.map(([id, url]) => [id, { name: images[id], url }])) };
      });
    });
    return () => {
      current = false;
    };
  }, [images]);
  const urls = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(images ?? {}).flatMap(([id, name]) => {
          const shown = placed[id];
          return shown?.name === name ? [[id, shown.url]] : [];
        }),
      ),
    [images, placed],
  );
  const folds = useMemo(() => quoteFolds(bodyOf(html)), [html]);
  const doc = useMemo(() => mailDocument(html, quoteOpen, urls), [html, quoteOpen, urls]);
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    let observer: ResizeObserver | null = null;
    let page: Document | null = null;
    const fit = () => {
      const root = el.contentDocument?.documentElement;
      if (root) setHeight(Math.max(40, Math.ceil(root.scrollHeight)));
    };
    const click = (e: MouseEvent) => {
      const inside = el.contentDocument?.defaultView;
      const target = inside && e.target instanceof inside.Element ? e.target.closest("a[href]") : null;
      if (!target) return;
      e.preventDefault();
      const href = target.getAttribute("href") ?? "";
      if (openableHref(href)) openExternal(href);
    };
    const loaded = () => {
      const next = el.contentDocument;
      if (!next) return;
      observer?.disconnect();
      observer = null;
      if (page) page.removeEventListener("click", click);
      page = next;
      fit();
      page.addEventListener("click", click);
      observer = new ResizeObserver(fit);
      observer.observe(page.documentElement);
    };
    el.addEventListener("load", loaded);
    if (el.contentDocument?.readyState === "complete") loaded();
    return () => {
      el.removeEventListener("load", loaded);
      observer?.disconnect();
      observer = null;
      if (page) page.removeEventListener("click", click);
      page = null;
    };
  }, [doc]);
  const page = (
    <iframe
      ref={frame}
      className="loki-mail-html"
      // Outside (HTML): a title shows as a tooltip over the whole mail, so the frame is named by aria-label instead.
      aria-label={title}
      // Outside (WebKit): the Mac's webview runs no listener of loki's inside a frame without scripts, so there a link
      // asks for a new window (base target _blank), which allow-popups lets through for the shell to send to the browser.
      sandbox="allow-same-origin allow-popups"
      srcDoc={doc}
      style={{ height }}
    />
  );
  if (!folds) return page;
  return (
    <div className="flex flex-col gap-2">
      {page}
      <button
        type="button"
        className="loki-mail-quote-toggle"
        aria-expanded={quoteOpen}
        aria-label={quoteOpen ? "Hide the earlier mail" : "Show the earlier mail"}
        title={quoteOpen ? "Hide the earlier mail quoted under this one" : "Show the earlier mail quoted under this one"}
        onClick={() => setQuoteOpen(!quoteOpen)}
      >
        •••
      </button>
    </div>
  );
}

export function linkParts(text: string): Array<{ at: number; text: string; href: string | null }> {
  const parts: Array<{ at: number; text: string; href: string | null }> = [];
  let at = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'\])]+/gi)) {
    const url = m[0].replace(/[.,;:!?]+$/, "");
    if (m.index > at) parts.push({ at, text: text.slice(at, m.index), href: null });
    parts.push({ at: m.index, text: url, href: url });
    at = m.index + url.length;
  }
  if (at < text.length) parts.push({ at, text: text.slice(at), href: null });
  return parts;
}

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
