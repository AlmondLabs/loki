import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { streamBlocks } from "../app/src/chat/stream-blocks.ts";
import { Transcript } from "../app/src/chat/transcript.tsx";

describe("a reply still being written, in blocks (plan 039)", () => {
  test("blocks end at blank lines, however many", () => {
    expect(streamBlocks("# Plan\n\nFirst para\nstill first\n\n\n- one\n- two\n\nlast wo")).toEqual([
      "# Plan",
      "First para\nstill first",
      "- one\n- two",
      "last wo",
    ]);
    expect(streamBlocks("")).toEqual([]);
    expect(streamBlocks("one\n\n")).toEqual(["one"]);
  });

  test("a fenced block keeps its blank lines, whether it is closed yet or not", () => {
    const code = "Run this:\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nThen this.";
    expect(streamBlocks(code)).toEqual(["Run this:", "```ts\nconst a = 1;\n\nconst b = 2;\n```", "Then this."]);
    expect(streamBlocks("Run this:\n\n~~~~\nfirst\n\nsecond")).toEqual(["Run this:", "~~~~\nfirst\n\nsecond"]);
    // A shorter or different fence inside does not close it.
    expect(streamBlocks("````md\n```\n\nstill code\n````\n\nafter")).toEqual(["````md\n```\n\nstill code\n````", "after"]);
  });
});

describe("the transcript draws a streaming reply in blocks (plan 039)", () => {
  const people = { user: { name: "You" }, assistant: { name: "ira" } };
  const reply = [
    "## Findings",
    "The **first** finding, with `code` and a [link](https://example.com).",
    "| a | b |\n| - | - |\n| 1 | 2 |",
    "```ts\nconst a = 1;\n\nconst b = 2;\n```",
    "1. one\n2. two",
    "And the last words so far",
  ].join("\n\n");
  const draw = (streaming: boolean) =>
    renderToStaticMarkup(
      createElement(Transcript, {
        rows: [
          { role: "user", text: "go" },
          { role: "assistant", text: reply },
        ],
        people,
        streaming,
      }),
    );
  // What a reader sees: the words without their spans, the cursor and the live class left out, and without the line
  // breaks react-markdown puts between blocks when it draws them in one go (whitespace between blocks draws nothing).
  const seen = (html: string) =>
    html
      .replace(/<span class="loki-word">([^<]*)<\/span>/g, "$1")
      .replace(/<span style="opacity:0.6">▍<\/span>/, "")
      .replace(" loki-md--live", "")
      .replace(/>\n</g, "><");

  // The reply's body alone (the last message's): a finished reply also gets its copy button, which a streaming one
  // waits for.
  const body = (html: string) => {
    const at = html.lastIndexOf('<div class="loki-md');
    return html.slice(at, html.indexOf("</div></div>", at));
  };

  test("drawn in blocks, it reads exactly as drawn whole, every word but code in its own span", () => {
    const live = draw(true);
    const done = draw(false);
    expect(body(seen(live))).toBe(body(seen(done)));
    expect(body(seen(live))).toContain("<ol><li>one</li><li>two</li></ol>");
    expect(live).toContain('<span class="loki-word">last </span>');
    expect(live).toContain("const a = 1;\n\nconst b = 2;");
    expect(done).not.toContain("loki-word");
  });
});
