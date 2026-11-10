import { describe, expect, test } from "vitest";
import { htmlToText, tidyMail } from "../core/mail-text.ts";

/** Email bodies as text a card can show (plan 068): laid out as a browser would, not as the source is spaced. */

describe("HTML mail as text", () => {
  test("a layout-table statement reads as paragraphs, without its source indentation or empty rows", () => {
    const html = `<html><head><style>td { color: red }</style><title>Statement</title></head><body>
      <span style="display:none !important">Your October statement is here</span>
      <table width="600">
        <tr>
          <td>
                Hello<br>
                        Sam Rivera,
          </td>
        </tr>
        <tr><td>&nbsp;</td></tr>
        <tr><td>
            Thank you for opting for e-statements.
        </td></tr>
        <tr><td>   </td></tr>
        <tr><td><a href="https://example.test/soa?t=abc">Click here</a> to view your statement for October&nbsp;2026.</td></tr>
      </table>
      <!-- tracking -->
    </body></html>`;
    expect(htmlToText(html)).toBe("Hello\nSam Rivera,\n\nThank you for opting for e-statements.\n\nClick here to view your statement for October 2026.");
  });
  test("lists become bullets, cells sit side by side, and entities are decoded", () => {
    expect(htmlToText("<p>Points:</p><ul><li>Renewal &ndash; 60&nbsp;days</li><li>Audit &amp; cost</li></ul>")).toBe(
      "Points:\n\n• Renewal – 60 days\n• Audit & cost",
    );
    expect(htmlToText("<table><tr><td>Fund</td><td>Units</td></tr><tr><td>Index&#x2122;</td><td>12.5</td></tr></table>")).toBe("Fund Units\nIndex™ 12.5");
    expect(htmlToText("it&rsquo;s &#8220;fine&#8221; &unknown;")).toBe("it’s “fine” &unknown;");
  });
  test("what never closes: a comment or a tag hides the rest, an element hides nothing, and a second like it is not searched for again", () => {
    expect(htmlToText("Hello<!-- and then nothing")).toBe("Hello");
    expect(htmlToText("Hello <b")).toBe("Hello");
    expect(htmlToText("<style>p{}</STYLE >one<style>two<style>three")).toBe("onetwothree");
    expect(htmlToText('<div style="display:none">preview</div>shown<span style="display: none">kept')).toBe("shownkept");
  });
  test("a mail of openers that never close is read in the time its length takes, not its square", () => {
    for (const unit of ["<!--", "<style>", '<div style="display:none">', "<li", "<", "<!-- x --><style>a"]) {
      const started = performance.now();
      htmlToText(unit.repeat(Math.ceil(400_000 / unit.length)));
      // The old patterns took over a minute here; a second leaves room for the slowest runner.
      expect(performance.now() - started).toBeLessThan(1000);
    }
  });
});

describe("plain mail tidied", () => {
  test("each line's spacing collapses and long runs of blank lines become one, invisible characters go", () => {
    expect(tidyMail("     Hello\r\n            Sam,\r\n\r\n\r\n\r\n   Thanks for  waiting.​  \n\n\n")).toBe("Hello\nSam,\n\nThanks for waiting.");
  });
  test("a single blank line between paragraphs stays", () => {
    expect(tidyMail("one\n\ntwo")).toBe("one\n\ntwo");
  });
});
