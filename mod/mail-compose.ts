import { htmlToText, tidyMail } from "../core/mail-text.ts";

/**
 * A mail reply's body as Gmail writes one (plan 076): the person's words, their signature, and the earlier mail under
 * it, quoted for a reply and set out with its headers for a forward, each in plain text and in HTML. Gmail's own class
 * names (`gmail_quote`, `gmail_signature`) go on the HTML, so Gmail folds the quote into "•••" for its readers. Pure,
 * so tests own every byte.
 */

/** The message a reply quotes or a forward carries: who wrote it, when (ISO), its headers, and its text and HTML. */
export interface QuotedMail {
  from: string;
  at: string;
  to: string;
  cc: string;
  subject: string;
  text: string;
  /** Its HTML part as written, or null when it has only text. */
  html: string | null;
}

/** What a body is made of: the person's words, their signature (HTML, as Gmail keeps it) or null, and the earlier mail. */
export interface MailBodyInput {
  text: string;
  signature: string | null;
  quoted: QuotedMail | null;
  forward: boolean;
  /** The time zone dates are written in; this Mac's when left out. */
  zone?: string;
}

/** HTML's special characters as entities, so text reads as text. */
export const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Plain text as HTML lines. */
const textHtml = (text: string): string => escapeHtml(text).replace(/\r?\n/g, "<br>");

/** A mail's HTML without its document around it: what is inside `<body>`, else the whole. */
const bodyOf = (html: string): string => /<body\b[^>]*>([\s\S]*)<\/body\s*>/i.exec(html)?.[1] ?? html;

/** When a mail was written, as Gmail's attribution line writes it: "Fri, 6 Nov 2026 at 10:02". */
export function mailDate(iso: string, zone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const opts = zone ? { timeZone: zone } : {};
  const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", ...opts }).replace(/,/g, "");
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, ...opts });
  const [weekday, ...rest] = day.split(" ");
  return `${weekday}, ${rest.join(" ")} at ${time}`;
}

/** A signature as plain text, the way a mail client sets it off: "-- " on its own line, then the signature. */
export const signatureText = (html: string): string => htmlToText(html);

/** The line that opens a quote: "On Fri, 6 Nov 2026 at 10:02, Pinku Kumar <pinku@acme.com> wrote:". */
function attribution(q: QuotedMail, zone?: string): string {
  const when = mailDate(q.at, zone);
  return `${when ? `On ${when}, ` : ""}${q.from} wrote:`;
}

/** The header block of a forwarded mail, line by line. */
function forwardHead(q: QuotedMail, zone?: string): string[] {
  return [
    "---------- Forwarded message ---------",
    `From: ${q.from}`,
    `Date: ${mailDate(q.at, zone)}`,
    `Subject: ${q.subject}`,
    `To: ${q.to}`,
    ...(q.cc ? [`Cc: ${q.cc}`] : []),
  ];
}

/** The reply's body in plain text and in HTML. */
export function mailBody(input: MailBodyInput): { text: string; html: string } {
  const { text, signature, quoted, forward, zone } = input;
  const words = text.replace(/\r\n?/g, "\n").trimEnd();
  const sigText = signature ? signatureText(signature) : "";
  const plain: string[] = [words];
  const html: string[] = [`<div dir="ltr">${textHtml(words)}</div>`];
  if (sigText) {
    plain.push("", "-- ", sigText);
    html.push(`<br clear="all"><div><br></div><span class="gmail_signature_prefix">-- </span><br><div dir="ltr" class="gmail_signature">${signature}</div>`);
  }
  // A mail with nothing in it to quote (only a subject) is answered without an empty quote.
  if (quoted && (quoted.text.trim() || quoted.html !== null)) {
    const original = tidyMail(quoted.text);
    const originalHtml = quoted.html !== null ? bodyOf(quoted.html) : `<div dir="ltr">${textHtml(original)}</div>`;
    if (forward) {
      const head = forwardHead(quoted, zone);
      plain.push("", ...head, "", original);
      html.push(`<br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">${head.map(escapeHtml).join("<br>")}<br></div><br><br>${originalHtml}</div>`);
    } else {
      const line = attribution(quoted, zone);
      plain.push("", line, ...original.split("\n").map((l) => (l ? `> ${l}` : ">")));
      html.push(
        `<br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">${escapeHtml(line)}<br></div>` +
          `<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">${originalHtml}</blockquote></div>`,
      );
    }
  }
  return { text: plain.join("\n"), html: html.join("") };
}

/** A forward's subject: the mail's own, with one "Fwd:" in front. */
export const forwardSubject = (subject: string): string => (/^fwd?:/i.test(subject.trim()) ? subject.trim() : `Fwd: ${subject.trim()}`.trim());

/**
 * A From header: `"Name" <address>`, the name in RFC 2047's encoded form when it is not plain ASCII, or the bare
 * address when there is no name.
 */
export function fromHeader(address: string, name: string): string {
  const n = name.replace(/["\\\r\n]/g, "").trim();
  if (!n) return address;
  return /^[\x20-\x7e]*$/.test(n) ? `"${n}" <${address}>` : `=?UTF-8?B?${Buffer.from(n, "utf8").toString("base64")}?= <${address}>`;
}
