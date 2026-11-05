import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OutsideFacts } from "../core/frame-types.ts";
import { MAIL_POLICY, linkParts, mailDocument, openableHref } from "../app/src/desk/mail-html.tsx";
import { OutsideThread } from "../app/src/desk/outside-card.tsx";

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

  test("a mail that is a bare fragment, with no head or body, is drawn whole", () => {
    expect(mailDocument("<p>hi</p>")).toContain("<body><p>hi</p></body>");
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

describe("the card", () => {
  test("a mail with HTML is drawn in a frame that runs no script; a plain one keeps its text, links made", () => {
    const html = renderToStaticMarkup(
      createElement(OutsideThread, {
        facts: FACTS,
        state: {
          kind: "read",
          messages: [
            { id: "m1", sender: "DOBIGCLOUD", at: "", text: "Bill", mine: false, html: "<p>Bill</p>" },
            { id: "m2", sender: "Ada", at: "", text: "See https://x.test", mine: true },
          ],
        },
      }),
    );
    expect(html).toContain("<iframe");
    expect(html).toContain('sandbox="allow-same-origin"');
    expect(html).not.toContain("allow-scripts");
    expect(html).toContain('href="https://x.test">https://x.test</a>');
  });
});
