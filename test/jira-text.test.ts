import { describe, expect, test } from "vitest";
import { adfBlocks, adfText, historyLines, textToAdf } from "../mod/jira-text.ts";

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

  test("a mention without a name, an emoji without its character, an attachment and a card keep their words", () => {
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
      { kind: "text", spans: [{ kind: "text", text: "[attachment]" }] },
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
