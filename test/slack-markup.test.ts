import { describe, expect, test } from "vitest";
import type { SlackNames } from "../mod/slack-markup.ts";
import { messageMarkup, reactionEmoji, readSlackMessage, searchEmoji, slackAttachments, slackBlocks, slackFileParts } from "../mod/slack-markup.ts";

/** A Slack message read the way Slack draws it (plan 075). */

const names: SlackNames = {
  person: (user) => Promise.resolve(user === "U1" ? "Vedansh Kapoor" : user),
  channel: (id) => Promise.resolve(id === "C9" ? "deploys" : null),
  emoji: (name) => ({ shipit: "https://emoji.example.test/shipit.png", yes: "alias:white_check_mark", whirl: "alias:whirl" })[name] ?? null,
};

describe("reading Slack's markup", () => {
  test("links keep their address, people and channels are mentions, and @channel is one too", async () => {
    const blocks = await slackBlocks("Please review <https://github.test/pr/2429|org/repo#2429>, <@U1> in <#C9|> &amp; <!here>", names);
    expect(blocks).toEqual([
      {
        kind: "text",
        spans: [
          { kind: "text", text: "Please review " },
          { kind: "link", text: "org/repo#2429", url: "https://github.test/pr/2429" },
          { kind: "text", text: ", " },
          { kind: "mention", text: "@Vedansh Kapoor" },
          { kind: "text", text: " in " },
          { kind: "mention", text: "#deploys" },
          { kind: "text", text: " & " },
          { kind: "mention", text: "@here" },
        ],
      },
    ]);
  });

  test("emoji become the character, with skin tones; the workspace's own are images, aliases followed; unknown names stay", async () => {
    const [b] = await slackBlocks(":white_check_mark: :+1::skin-tone-3: :shipit: :yes: :whirl: :nope: at 10:30:45", names);
    expect(b.spans).toEqual([
      { kind: "emoji", text: "\u2705\uFE0F" },
      { kind: "text", text: " " },
      { kind: "emoji", text: "👍🏼" },
      { kind: "text", text: " " },
      { kind: "emoji", text: ":shipit:", image: "https://emoji.example.test/shipit.png" },
      { kind: "text", text: " " },
      { kind: "emoji", text: "\u2705\uFE0F" },
      { kind: "text", text: " :whirl: :nope: at 10:30:45" },
    ]);
  });

  test("bold, italic, strike and code are read where Slack reads them, and a link's underscores are left alone", async () => {
    const [b] = await slackBlocks("*done* _soon_ ~gone~ `a_b` snake_case_name *<https://x.test/a_b|the doc>*", names);
    expect(b.spans).toEqual([
      { kind: "text", text: "done", bold: true },
      { kind: "text", text: " " },
      { kind: "text", text: "soon", italic: true },
      { kind: "text", text: " " },
      { kind: "text", text: "gone", strike: true },
      { kind: "text", text: " " },
      { kind: "text", text: "a_b", code: true },
      { kind: "text", text: " snake_case_name " },
      { kind: "link", text: "the doc", url: "https://x.test/a_b", bold: true },
    ]);
  });

  test("markers around a link's whole label style the link, as Sentry writes them; markers inside it stay", async () => {
    const [b] = await slackBlocks(":red_circle: <https://sentry.test/1|*TypeError*> <https://x.test|_*both*_> <https://x.test|a*b>", names);
    expect(b.spans).toEqual([
      { kind: "emoji", text: "\u{1F534}" },
      { kind: "text", text: " " },
      { kind: "link", text: "TypeError", url: "https://sentry.test/1", bold: true },
      { kind: "text", text: " " },
      { kind: "link", text: "both", url: "https://x.test", bold: true, italic: true },
      { kind: "text", text: " " },
      { kind: "link", text: "a*b", url: "https://x.test" },
    ]);
  });

  test("quotes and code blocks are their own paragraphs; lines inside one are kept", async () => {
    const blocks = await slackBlocks("first\nsecond\n&gt; quoted\n&gt; more\n```\nnpm *test*\n```\nafter", names);
    expect(blocks.map((b) => [b.kind, b.spans.map((s) => s.text).join("")])).toEqual([
      ["text", "first\nsecond"],
      ["quote", "quoted\nmore"],
      ["code", "npm *test*"],
      ["text", "after"],
    ]);
  });
});

describe("what an app posts", () => {
  test("a message of layout blocks is read from them; one with rich text keeps its text", () => {
    const blocks = [
      { type: "header", text: { type: "plain_text", text: "Deploy done" } },
      { type: "section", text: { type: "mrkdwn", text: "Shipped <https://x.test|v2>" }, fields: [{ type: "mrkdwn", text: "*Env* prod" }] },
      { type: "context", elements: [{ type: "mrkdwn", text: "by ci" }] },
    ];
    expect(messageMarkup({ text: "summary", raw: { blocks } })).toBe("*Deploy done*\nShipped <https://x.test|v2>\n*Env* prod\nby ci");
    expect(messageMarkup({ text: "the text", raw: { blocks: [{ type: "rich_text", elements: [] }] } })).toBe("the text");
  });

  test("an attachment brings its lead line, linked title, text, fields and colour; an empty one is left out", async () => {
    const raw = {
      attachments: [
        {
          pretext: "New pull request",
          title: "Fix the &lt;card&gt;",
          title_link: "https://github.test/pr/1",
          text: "Closes :bug:",
          fields: [{ title: "Reviewers", value: "<@U1>" }],
          color: "good",
        },
        { color: "36a64f" },
      ],
    };
    const [a, ...rest] = await slackAttachments({ raw }, names);
    expect(rest).toEqual([]);
    expect(a.title).toEqual([{ kind: "link", text: "Fix the <card>", url: "https://github.test/pr/1" }]);
    expect(a.color).toBe("#2eb886");
    expect(a.fields?.[0].title).toBe("Reviewers");
    const read = await readSlackMessage({ text: "Please review this PR", raw }, names);
    expect(read.text).toBe("Please review this PR\nNew pull request\nFix the <card> (https://github.test/pr/1)\nCloses 🐛\nReviewers: @Vedansh Kapoor");
  });
});

describe("the emoji a reaction draws and the person can pick (plan 079)", () => {
  const OWN: Record<string, string> = { shipit: "https://example.test/shipit.png", ship_it: "alias:shipit" };
  const own = (n: string): string | null => (Object.hasOwn(OWN, n) ? OWN[n] : null);

  test("a reaction's name is a standard emoji, its skin tone after ::, or the workspace's own image; an unknown one is null", () => {
    expect(reactionEmoji("eyes", {})).toEqual({ kind: "emoji", text: "👀" });
    expect(reactionEmoji("+1::skin-tone-2", {})).toEqual({ kind: "emoji", text: "👍\u{1F3FB}" });
    expect(reactionEmoji("ship_it", { emoji: own })).toEqual({ kind: "emoji", text: ":shipit:", image: OWN.shipit });
    expect(reactionEmoji("not_an_emoji_anywhere", {})).toBeNull();
  });

  test("a search finds names holding the query, a whole match first, the workspace's own included, each emoji once", () => {
    const ship = searchEmoji("ship", OWN);
    expect(ship[0]).toEqual({ name: "ship", emoji: { kind: "emoji", text: "🚢" } });
    expect(ship.filter((c) => c.emoji.image === OWN.shipit)).toEqual([{ name: "shipit", emoji: { kind: "emoji", text: ":shipit:", image: OWN.shipit } }]);
    expect(searchEmoji(":eyes:", {})[0]?.name).toBe("eyes");
    expect(searchEmoji("thumbsup", {}).map((c) => c.emoji.text)).toContain("👍");
    expect(searchEmoji("  ", OWN)).toEqual([]);
    expect(searchEmoji("e", {}, 5)).toHaveLength(5);
  });
});

describe("the files shared in a message (plan 080)", () => {
  const files = [
    { title: "Invoice March", name: "invoice.pdf", pretty_type: "PDF", size: 120_000, permalink: "https://acme.slack.test/files/U1/F1/invoice.pdf" },
    { name: "photo.png", filetype: "png", permalink: "slack://file?id=F2" },
    { mode: "tombstone" },
    { mode: "hidden_by_limit" },
    "not a file",
  ];

  test("each file comes with its title, kind, size and page in Slack; a deleted or hidden one says only that", async () => {
    const read = await readSlackMessage({ text: "", raw: { files } }, names);
    expect(read.files).toEqual([
      { name: "Invoice March", kind: "PDF", size: 120_000, link: "https://acme.slack.test/files/U1/F1/invoice.pdf" },
      { name: "photo.png", kind: "PNG", size: null, link: null },
      { name: "", kind: null, size: null, link: null, gone: "deleted" },
      { name: "", kind: null, size: null, link: null, gone: "hidden" },
    ]);
    // A message of only files is not empty as plain text, for the phone and a hand-off.
    expect(read.text).toBe("file: Invoice March\nfile: photo.png\nfile: deleted\nfile: hidden by the workspace's plan");
  });

  test("a message with no files has none", async () => {
    expect((await readSlackMessage({ text: "hi", raw: {} }, names)).files).toEqual([]);
  });

  test("a picture says where its thumbnail is, the 360-pixel one first; other files and pictures without one say none", () => {
    const parts = slackFileParts({
      raw: {
        files: [
          {
            name: "a.png",
            mimetype: "image/png",
            thumb_360: "https://files.slack.com/a_360.png",
            thumb_360_w: 360,
            thumb_360_h: 200,
            thumb_160: "https://files.slack.com/a_160.png",
            thumb_160_w: 160,
            thumb_160_h: 89,
          },
          { name: "b.jpg", mimetype: "image/jpeg", thumb_160: "https://files.slack.com/b_160.jpg", thumb_160_w: 120, thumb_160_h: 160 },
          { name: "c.png", mimetype: "image/png" },
          { name: "d.pdf", mimetype: "application/pdf", thumb_360: "https://files.slack.com/d_360.png", thumb_360_w: 360, thumb_360_h: 480 },
        ],
      },
    });
    expect(parts.map((p) => p.thumb)).toEqual([
      { url: "https://files.slack.com/a_360.png", width: 360, height: 200 },
      { url: "https://files.slack.com/b_160.jpg", width: 120, height: 160 },
      null,
      null,
    ]);
  });
});
