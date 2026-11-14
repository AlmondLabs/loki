import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OutsideFacts } from "../core/frame-types.ts";
import { MAIL_POLICY, darkRulesOff, linkParts, mailDocument, openableHref, quoteFolds } from "../app/src/desk/mail-html.tsx";
import { OutsideThread } from "../app/src/desk/outside-card.tsx";
import { firstLine } from "../app/src/desk/mail-thread.tsx";

/** A mail drawn as its sender wrote it, in a frame where nothing runs, its links opened in the browser. */

const BILL = [
  "<html><head><style>.total{font-weight:bold}</style><script>steal()</script></head>",
  '<body><p class="total">Amount 6490.0 INR</p><a href="https://bills.example/pdf">CLICK HERE</a>',
  '<script src="https://evil.example/x.js"></script><iframe src="https://evil.example"></iframe>',
  '<object data="x.swf"></object><meta http-equiv="refresh" content="0;url=https://evil.example"><base href="https://evil.example/">',
  '<div class="gmail_quote">On Tue, Bob wrote: old</div></body></html>',
].join("");

describe("the frame's document for a mail", () => {
  test("keeps the mail's styles, body and links, under a policy that loads only images, styles and fonts", () => {
    const doc = mailDocument(BILL);
    expect(doc).toContain(`content="${MAIL_POLICY}"`);
    expect(MAIL_POLICY).toContain("default-src 'none'");
    expect(MAIL_POLICY).toContain("img-src https:");
    expect(doc).toContain(".total{font-weight:bold}");
    expect(doc).toContain('<p class="total">Amount 6490.0 INR</p>');
    expect(doc).toContain('<a href="https://bills.example/pdf">CLICK HERE</a>');
    expect(doc).toContain('<base target="_blank">');
  });

  test("scripts, frames, objects, refresh and the mail's own base tag are taken out", () => {
    const doc = mailDocument(BILL);
    for (const gone of ["steal()", "evil.example/x.js", "<iframe", "<object", 'http-equiv="refresh"', 'href="https://evil.example/"'])
      expect(doc).not.toContain(gone);
  });

  test("what the mail loads carries no referrer, whatever rule the mail brings of its own", () => {
    const doc = mailDocument(
      `<html><body><meta name="referrer" content="unsafe-url"><META content=unsafe-url NAME=referrer><img referrerpolicy="unsafe-url" src="https://x.example/a.png"><a href="https://x.example" ReferrerPolicy=unsafe-url>go</a></body></html>`,
    );
    expect(doc).toContain('<meta name="referrer" content="no-referrer">');
    // The word appears twice in loki's own tag (its name and its value) and nowhere else.
    expect(doc.match(/referrer/gi)).toHaveLength(2);
    expect(doc).toContain('<img src="https://x.example/a.png">');
    expect(doc).toContain('<a href="https://x.example">go</a>');
  });

  test("a tag with no end tag, such as base, is taken out alone and leaves the rest of the mail", () => {
    const doc = mailDocument('<p>one</p><base href="https://evil.example/"><embed src="x.swf"><p>two</p>');
    expect(doc).toContain("<p>one</p><p>two</p>");
  });

  test("a mail that is a bare fragment, with no head or body, is drawn whole", () => {
    expect(mailDocument("<p>hi</p>")).toContain("<body><p>hi</p></body>");
  });

  test("folds a reply's quoted thread, and draws it when opened", () => {
    expect(mailDocument(BILL)).toContain(".gmail_quote,blockquote[type=cite],.yahoo_quoted{display:none}");
    expect(mailDocument(BILL, true)).not.toContain("{display:none}");
  });

  test("a forward reads open, with a note above it or without", () => {
    const forwarded = '<div class="gmail_quote"><div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br></div><p>Terms</p></div>';
    expect(mailDocument(`<div dir="ltr"><br></div>${forwarded}`)).not.toContain("{display:none}");
    expect(mailDocument(`<div dir="ltr">FYI in case this is relevant</div>${forwarded}`)).not.toContain("{display:none}");
    expect(quoteFolds('<p>FYI</p><blockquote type="cite"><div>Begin forwarded message:</div><p>Terms</p></blockquote>')).toBe(false);
  });

  test("a quote folds only under a part of the mail's own: text or an image", () => {
    expect(quoteFolds('<p>Thanks</p><div class="gmail_quote">On Tue, Bob wrote: old</div>')).toBe(true);
    expect(quoteFolds('<p><img src="cid:a"></p><blockquote type="cite">old</blockquote>')).toBe(true);
    expect(quoteFolds('<div>&nbsp;<br></div><div class="yahoo_quoted">old</div>')).toBe(false);
    expect(quoteFolds("<p>no quote at all</p>")).toBe(false);
  });

  test("a reply quoting an earlier forward still folds", () => {
    const reply =
      '<p>Thanks</p><div class="gmail_quote"><div class="gmail_attr">On Tue, Bob wrote:</div><blockquote>---------- Forwarded message ---------</blockquote></div>';
    expect(quoteFolds(reply)).toBe(true);
  });

  test("only web and mail links leave for the browser", () => {
    expect(["https://x.test", "http://x.test", "mailto:a@b.test"].map(openableHref)).toEqual([true, true, true]);
    expect(["javascript:alert(1)", "file:///etc/passwd", "loki://x", "#top"].map(openableHref)).toEqual([false, false, false, false]);
  });
});

describe("a plain mail's links", () => {
  test("web addresses become links; a full stop after one is not part of it", () => {
    expect(linkParts("Bill at https://x.test/a.pdf. Thanks")).toEqual([
      { at: 0, text: "Bill at ", href: null },
      { at: 8, text: "https://x.test/a.pdf", href: "https://x.test/a.pdf" },
      { at: 28, text: ". Thanks", href: null },
    ]);
    expect(linkParts("no links here")).toEqual([{ at: 0, text: "no links here", href: null }]);
  });
});

const FACTS: OutsideFacts = {
  account_id: "gmail:ada@acme.com",
  provider: "gmail",
  account_label: "ada@acme.com",
  thread_id: "t1",
  generation: 0,
  owner_agent_id: "agent-work",
  owner_name: "friday",
  sender: "DOBIGCLOUD",
  sender_address: null,
  subject: "Bill",
  lines: ["Bill"],
  newest_message_id: "m1",
  newest_at: "2026-11-05T10:00:00.000Z",
  handoff_conversation_id: null,
  disconnected: null,
};

describe("a mail's own dark rules", () => {
  test("are turned off, so a mail that brings them keeps dark text on its light page", () => {
    const invite = [
      "<html><head><style>.name{color:#3c4043}@media (prefers-color-scheme: dark){.name{color:#e8eaed}}</style></head>",
      '<body><style>@media screen and (PREFERS-COLOR-SCHEME:dark){a{color:#fff}}</style><a class="name">Ada</a></body></html>',
    ].join("");
    const doc = mailDocument(invite);
    expect(doc).not.toMatch(/prefers-color-scheme\s*:\s*dark/i);
    expect(doc).toContain(".name{color:#3c4043}");
    expect(darkRulesOff("@media (prefers-color-scheme: light){a{color:red}}")).toBe("@media (prefers-color-scheme: light){a{color:red}}");
  });
});

describe("the card", () => {
  test("a mail with HTML is drawn in a frame that runs no script", () => {
    const html = renderToStaticMarkup(
      createElement(OutsideThread, {
        facts: FACTS,
        state: {
          kind: "read",
          messages: [
            { id: "m1", sender: "Ada", at: "", text: "See https://x.test", mine: true },
            { id: "m2", sender: "DOBIGCLOUD", at: "", text: "Bill", mine: false, html: "<p>Bill</p>" },
          ],
        },
      }),
    );
    expect(html).toContain("<iframe");
    // Named for screen readers without a title, which the Mac shows as a tooltip over the whole mail.
    expect(html).toMatch(/<iframe[^>]*aria-label="Mail from DOBIGCLOUD"/);
    expect(html).not.toMatch(/<iframe[^>]*title=/);
    // Popups only so the Mac's webview can hand a clicked link to the shell, which sends it to the browser.
    expect(html).toContain('sandbox="allow-same-origin allow-popups"');
    expect(html).not.toContain("allow-scripts");
  });

  test("a mail before the newest is folded to one line, so a bill sent three times draws once", () => {
    const bill = { sender: "DOBIGCLOUD", at: "", text: "\n  Your bill is ready\nAmount 6490.0 INR", mine: false, html: "<p>Bill</p>" };
    const html = renderToStaticMarkup(
      createElement(OutsideThread, {
        facts: FACTS,
        state: {
          kind: "read",
          messages: [
            { id: "m1", ...bill },
            { id: "m2", ...bill },
            { id: "m3", ...bill },
          ],
        },
      }),
    );
    expect(html.match(/<iframe/g)).toHaveLength(1);
    expect(html.match(/class="loki-mail-msg loki-mail-msg--folded"/g)).toHaveLength(2);
    expect(html).toContain("Your bill is ready");
  });

  test("a Slack thread is never folded: every message shows, its addresses made links", () => {
    const html = renderToStaticMarkup(
      createElement(OutsideThread, {
        facts: { ...FACTS, provider: "slack" },
        state: {
          kind: "read",
          messages: [
            { id: "1", sender: "Ada", at: "", text: "one", mine: false },
            { id: "2", sender: "Ada", at: "", text: "two, see https://x.test", mine: false },
          ],
        },
      }),
    );
    expect(html).not.toContain("loki-mail-fold");
    expect(html).toContain("one");
    expect(html).toContain('href="https://x.test">https://x.test</a>');
  });
});

describe("a folded mail's line", () => {
  test("is the first line with words in it", () => {
    expect(firstLine("\n \n  Hello there \nmore")).toBe("Hello there");
    expect(firstLine("")).toBe("");
  });
});
