import { describe, expect, test } from "vitest";
import { adfBlocks, adfFiles, adfText, historyLines, textToAdf } from "../mod/jira-text.ts";

const text = (t: string, marks?: unknown[]) => ({ type: "text", text: t, ...(marks ? { marks } : {}) });
const paragraph = (...content: unknown[]) => ({ type: "paragraph", content });
const doc = (...content: unknown[]) => ({ version: 1, type: "doc", content });

describe("a Jira document as plain lines", () => {
  test("paragraphs, a hard break, a bullet list, a code block, a link and a mention become lines, the mention as its name", () => {
    const body = doc(
      paragraph(
        text("Hi "),
        { type: "mention", attrs: { id: "acc-ada", text: "@Ada Lovelace" } },
        text(", two things."),
        { type: "hardBreak" },
        text("Both small."),
      ),
      {
        type: "bulletList",
        content: [
          { type: "listItem", content: [paragraph(text("the build"))] },
          { type: "listItem", content: [paragraph(text("the "), text("notes", [{ type: "link", attrs: { href: "https://example.com/notes" } }]))] },
        ],
      },
      { type: "codeBlock", attrs: { language: "sh" }, content: [text("npm test\nnpm run lint")] },
      paragraph({ type: "inlineCard", attrs: { url: "https://acme.atlassian.net/browse/OPS-7" } }),
    );
    expect(adfText(body)).toEqual({
      lines: [
        "Hi @Ada Lovelace, two things.",
        "Both small.",
        "- the build",
        "- the notes (https://example.com/notes)",
        "npm test",
        "npm run lint",
        "https://acme.atlassian.net/browse/OPS-7",
      ],
      mentions: ["acc-ada"],
    });
  });

  test("a numbered list counts its items, and a list inside an item sits under it", () => {
    const body = doc({
      type: "orderedList",
      content: [
        { type: "listItem", content: [paragraph(text("first")), { type: "bulletList", content: [{ type: "listItem", content: [paragraph(text("inner"))] }] }] },
        { type: "listItem", content: [paragraph(text("second"))] },
      ],
    });
    expect(adfText(body).lines).toEqual(["1. first", "   - inner", "2. second"]);
  });

  test("each person mentioned is named once, and a mention without a name still reads as one", () => {
    const body = doc(
      paragraph({ type: "mention", attrs: { id: "acc-ada", text: "@Ada" } }, text(" and "), { type: "mention", attrs: { id: "acc-bob" } }),
      paragraph({ type: "mention", attrs: { id: "acc-ada", text: "@Ada" } }),
    );
    expect(adfText(body)).toEqual({ lines: ["@Ada and @someone", "@Ada"], mentions: ["acc-ada", "acc-bob"] });
  });

  test("an unknown node type keeps its text and does not throw", () => {
    const body = doc(
      { type: "futurePanel", attrs: { mood: "calm" }, content: [paragraph(text("inside a panel"))] },
      paragraph(text("before "), { type: "futureInline", content: [text("kept")] }),
      { type: "futureLeaf" },
    );
    expect(adfText(body).lines.join(" ")).toBe("inside a panel before kept");
  });

  test("something that is no document gives no lines", () => {
    expect(adfText(null)).toEqual({ lines: [], mentions: [] });
    expect(adfText("plain")).toEqual({ lines: [], mentions: [] });
  });
});

describe("a Jira document as the Slack card's blocks (plan 091)", () => {
  const mark = (type: string, attrs?: Record<string, unknown>) => ({ type, ...(attrs ? { attrs } : {}) });

  test("marks, a link by its label, a mention, an emoji, a hard break, a heading, a quote and a code block draw as Slack's blocks and spans", () => {
    const body = doc(
      { type: "heading", attrs: { level: 2 }, content: [text("Plan")] },
      paragraph(
        text("Hi "),
        { type: "mention", attrs: { id: "acc-ada", text: "@Ada Lovelace" } },
        text(", this is "),
        text("bold", [mark("strong")]),
        text(", "),
        text("slanted", [mark("em")]),
        text(", "),
        text("gone", [mark("strike")]),
        text(" and "),
        text("npm test", [mark("code")]),
        text(" "),
        { type: "emoji", attrs: { shortName: ":tada:", text: "🎉" } },
        { type: "hardBreak" },
        text("see "),
        text("the notes", [mark("link", { href: "https://example.com/notes" }), mark("strong")]),
      ),
      { type: "blockquote", content: [paragraph(text("quoted")), paragraph(text("twice"))] },
      { type: "codeBlock", attrs: { language: "sh" }, content: [text("npm test\nnpm run lint")] },
    );
    expect(adfBlocks(body)).toEqual([
      { kind: "text", spans: [{ kind: "text", text: "Plan", bold: true }] },
      {
        kind: "text",
        spans: [
          { kind: "text", text: "Hi " },
          { kind: "mention", text: "@Ada Lovelace" },
          { kind: "text", text: ", this is " },
          { kind: "text", text: "bold", bold: true },
          { kind: "text", text: ", " },
          { kind: "text", text: "slanted", italic: true },
          { kind: "text", text: ", " },
          { kind: "text", text: "gone", strike: true },
          { kind: "text", text: " and " },
          { kind: "text", text: "npm test", code: true },
          { kind: "text", text: " " },
          { kind: "emoji", text: "🎉" },
          { kind: "text", text: "\nsee " },
          { kind: "link", text: "the notes", url: "https://example.com/notes", bold: true },
        ],
      },
      { kind: "quote", spans: [{ kind: "text", text: "quoted\ntwice" }] },
      { kind: "code", spans: [{ kind: "text", text: "npm test\nnpm run lint", code: true }] },
    ]);
  });

  test("bullet and numbered lists are lines with their marks, a list inside an item indented under it", () => {
    const body = doc(
      {
        type: "orderedList",
        attrs: { order: 3 },
        content: [
          {
            type: "listItem",
            content: [paragraph(text("first")), { type: "bulletList", content: [{ type: "listItem", content: [paragraph(text("inner", [mark("em")]))] }] }],
          },
          { type: "listItem", content: [paragraph(text("second"))] },
        ],
      },
      { type: "bulletList", content: [{ type: "listItem", content: [paragraph(text("dot"))] }] },
    );
    expect(adfBlocks(body)).toEqual([
      {
        kind: "text",
        spans: [
          { kind: "text", text: "3. first\n   • " },
          { kind: "text", text: "inner", italic: true },
          { kind: "text", text: "\n4. second" },
        ],
      },
      { kind: "text", spans: [{ kind: "text", text: "• dot" }] },
    ]);
  });

  test("a mention without a name, an emoji without its character and a card keep their words, and a file draws no block", () => {
    const body = doc(
      paragraph({ type: "mention", attrs: { id: "acc-bob" } }, text(" "), { type: "emoji", attrs: { shortName: ":party-parrot:" } }),
      { type: "mediaSingle", content: [{ type: "media", attrs: { id: "m1", type: "file" } }] },
      paragraph({ type: "inlineCard", attrs: { url: "https://acme.atlassian.net/browse/OPS-7" } }),
    );
    expect(adfBlocks(body)).toEqual([
      {
        kind: "text",
        spans: [
          { kind: "mention", text: "@someone" },
          { kind: "text", text: " :party-parrot:" },
        ],
      },
      { kind: "text", spans: [{ kind: "link", text: "https://acme.atlassian.net/browse/OPS-7", url: "https://acme.atlassian.net/browse/OPS-7" }] },
    ]);
  });

  test("an unknown node keeps its text, an empty paragraph draws nothing, and something that is no document gives no blocks", () => {
    const body = doc(
      { type: "futurePanel", content: [paragraph(text("inside a panel"))] },
      paragraph(text("before "), { type: "futureInline", content: [text("kept")] }),
      paragraph(),
      { type: "futureLeaf" },
    );
    expect(adfBlocks(body)).toEqual([
      { kind: "text", spans: [{ kind: "text", text: "inside a panel" }] },
      { kind: "text", spans: [{ kind: "text", text: "before kept" }] },
    ]);
    expect(adfBlocks(null)).toEqual([]);
    expect(adfBlocks("plain")).toEqual([]);
  });
});

describe("a Jira document's files (plan 092)", () => {
  const media = (attrs: Record<string, unknown>) => ({ type: "media", attrs: { id: "m1", type: "file", collection: "", ...attrs } });
  const single = (...content: unknown[]) => ({ type: "mediaSingle", attrs: { layout: "center" }, content });

  test("a comment that is only a picture lists its file and reads as its name", () => {
    const body = doc(single(media({ alt: "shot.png" })));
    expect(adfFiles(body)).toEqual([{ name: "shot.png", type: "file", url: null, width: null, height: null }]);
    expect(adfText(body).lines).toEqual(["file: shot.png"]);
    expect(adfBlocks(body)).toEqual([]);
  });

  test("a group of two files lists both in order, each on its own line", () => {
    const body = doc({ type: "mediaGroup", content: [media({ id: "m1", alt: "report.pdf" }), media({ id: "m2", alt: "notes.txt" })] });
    expect(adfFiles(body).map((f) => f.name)).toEqual(["report.pdf", "notes.txt"]);
    expect(adfText(body).lines).toEqual(["file: report.pdf", "file: notes.txt"]);
    expect(adfBlocks(body)).toEqual([]);
  });

  test("a file without a name reads as an attachment", () => {
    const body = doc(single(media({})));
    expect(adfFiles(body)).toEqual([{ name: null, type: "file", url: null, width: null, height: null }]);
    expect(adfText(body).lines).toEqual(["file: attachment"]);
  });

  test("an external file carries its https address, and only an https one", () => {
    const body = doc(
      single(media({ type: "external", url: "https://example.com/cat.gif", alt: "cat.gif", width: 480, height: 270 })),
      single(media({ type: "external", url: "http://example.com/dog.gif" })),
    );
    expect(adfFiles(body)).toEqual([
      { name: "cat.gif", type: "external", url: "https://example.com/cat.gif", width: 480, height: 270 },
      { name: null, type: "external", url: null, width: null, height: null },
    ]);
  });

  test("words, then a picture, then words: the blocks hold the two paragraphs, the text has the file between them", () => {
    const body = doc(paragraph(text("before")), single(media({ alt: "shot.png" })), paragraph(text("after")));
    expect(adfBlocks(body)).toEqual([
      { kind: "text", spans: [{ kind: "text", text: "before" }] },
      { kind: "text", spans: [{ kind: "text", text: "after" }] },
    ]);
    expect(adfText(body).lines).toEqual(["before", "file: shot.png", "after"]);
  });

  test("a file inside a paragraph is listed and gets a line of its own, and draws nothing in the paragraph", () => {
    const body = doc(paragraph(text("see "), { type: "mediaInline", attrs: { id: "m3", type: "file", alt: "log.txt" } }, text(" here")));
    expect(adfFiles(body)).toEqual([{ name: "log.txt", type: "file", url: null, width: null, height: null }]);
    expect(adfText(body).lines).toEqual(["see", "file: log.txt", "here"]);
    expect(adfBlocks(body)).toEqual([{ kind: "text", spans: [{ kind: "text", text: "see  here" }] }]);
  });

  test("a picture's caption keeps its words as a block", () => {
    const body = doc(single(media({ alt: "shot.png" }), { type: "caption", content: [text("the broken page")] }));
    expect(adfBlocks(body)).toEqual([{ kind: "text", spans: [{ kind: "text", text: "the broken page" }] }]);
    expect(adfText(body).lines).toEqual(["file: shot.png", "the broken page"]);
  });

  test("mentions beside a file are still collected", () => {
    const body = doc(paragraph({ type: "mention", attrs: { id: "acc-ada", text: "@Ada" } }, text(" look")), single(media({ alt: "shot.png" })));
    expect(adfText(body)).toEqual({ lines: ["@Ada look", "file: shot.png"], mentions: ["acc-ada"] });
  });

  test("no [attachment] remains for a named file, and something that is no document has no files", () => {
    const body = doc(single(media({ alt: "shot.png" })), { type: "mediaGroup", content: [media({ alt: "a.pdf" })] });
    expect(JSON.stringify([adfText(body), adfBlocks(body)])).not.toContain("[attachment]");
    expect(adfFiles(null)).toEqual([]);
  });
});

describe("a history entry as lines", () => {
  test("a status change reads as the field with its old and new values", () => {
    expect(historyLines([{ field: "status", from: "To Do", to: "In Progress" }])).toEqual(["status: To Do → In Progress"]);
  });

  test("several items give one line each, and a value that was or became empty says so", () => {
    expect(
      historyLines([
        { field: "assignee", from: null, to: "Ada Lovelace" },
        { field: "Sprint", from: "Sprint 4", to: null },
        { field: "description", from: "one\nline", to: "two\n\nlines" },
      ]),
    ).toEqual(["assignee: none → Ada Lovelace", "Sprint: Sprint 4 → none", "description: one line → two lines"]);
  });
});

describe("the person's text as a Jira document", () => {
  test("blank lines part paragraphs, and a single newline is a line break inside one", () => {
    expect(textToAdf("Looks good.\nShip it.\n\nThanks")).toEqual({
      version: 1,
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Looks good." }, { type: "hardBreak" }, { type: "text", text: "Ship it." }] },
        { type: "paragraph", content: [{ type: "text", text: "Thanks" }] },
      ],
    });
  });

  test("Windows line ends and runs of blank lines leave no empty text or paragraph", () => {
    expect(textToAdf("a\r\n\r\n\r\n\r\nb\r\n")).toEqual({
      version: 1,
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "a" }] },
        { type: "paragraph", content: [{ type: "text", text: "b" }] },
      ],
    });
  });

  test("what it writes reads back as the same lines", () => {
    expect(adfText(textToAdf("one\ntwo\n\nthree")).lines).toEqual(["one", "two", "three"]);
  });
});
