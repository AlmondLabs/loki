import { htmlToText, tidyMail } from "../core/mail-text.ts";

export interface QuotedMail {
  from: string;
  at: string;
  to: string;
  cc: string;
  subject: string;
  text: string;
  html: string | null;
}

export interface MailBodyInput {
  text: string;
  signature: string | null;
  quoted: QuotedMail | null;
  forward: boolean;
  zone?: string;
}

export const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const textHtml = (text: string): string => escapeHtml(text).replace(/\r?\n/g, "<br>");

const bodyOf = (html: string): string => /<body\b[^>]*>([\s\S]*)<\/body\s*>/i.exec(html)?.[1] ?? html;

export function mailDate(iso: string, zone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const opts = zone ? { timeZone: zone } : {};
  const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", ...opts }).replace(/,/g, "");
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, ...opts });
  const [weekday, ...rest] = day.split(" ");
  return `${weekday}, ${rest.join(" ")} at ${time}`;
}

export const signatureText = (html: string): string => htmlToText(html);

function attribution(q: QuotedMail, zone?: string): string {
  const when = mailDate(q.at, zone);
  return `${when ? `On ${when}, ` : ""}${q.from} wrote:`;
}

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
