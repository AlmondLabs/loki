import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TranscriptRow } from "../core/attention/transcript.ts";
import { COMPACTED_TEXT } from "../core/attention/thread.ts";
import type { SlackReaction } from "../core/frame-types.ts";
import { ChatMessage, FoldedEntry, MessageEntry } from "../app/src/item/message-entry.tsx";
import { ContentParts } from "../app/src/item/content-parts.tsx";
import { Reactions } from "../app/src/item/reactions.tsx";
import { ChangeEntry, EventEntry } from "../app/src/item/event-entry.tsx";
import type { ItemEntry } from "../app/src/item/item-view.ts";

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);

const message = (over: Partial<Extract<ItemEntry, { kind: "message" }>> = {}): Extract<ItemEntry, { kind: "message" }> => ({
  kind: "message",
  key: "m-1",
  from: "person",
  who: "Priya Raman",
  avatar: null,
  at: "",
  parts: [{ kind: "text", text: "Can we move the review to Thursday?" }],
  reactions: [],
  mentions_you: false,
  in_thread: false,
  ...over,
});

const thumbs = (mine: boolean): SlackReaction => ({ name: "+1", count: 2, mine, emoji: { kind: "emoji", text: "👍" } });

describe("MessageEntry", () => {
  test("a person's message has their initial, name and words, and no reactions footer when it has none", () => {
    const out = html(createElement(MessageEntry, { entry: message(), source: "slack" }));
    expect(out).toContain('data-row="person"');
    expect(out).toContain(">P<");
    expect(out).toContain("Priya Raman");
    expect(out).toContain("Thursday?");
    expect(out).not.toContain("data-reactions");
  });

  test("a message that mentions you is marked; one in the thread is indented", () => {
    expect(html(createElement(MessageEntry, { entry: message({ mentions_you: true }), source: "slack" }))).toContain('data-mentions="true"');
    expect(html(createElement(MessageEntry, { entry: message({ in_thread: true }), source: "slack" }))).toContain("pl-6");
  });

  test("the head is the name, then the detail, with when it was sent last; the line sits under it", () => {
    const out = html(
      createElement(MessageEntry, { entry: message(), source: "gmail", when: "14 Nov", detail: "priya@northwind.example", line: "to you, cc Ben" }),
    );
    expect(out.indexOf("Priya Raman")).toBeLessThan(out.indexOf("priya@northwind.example"));
    expect(out.indexOf("priya@northwind.example")).toBeLessThan(out.indexOf(">14 Nov<"));
    expect(out.indexOf(">14 Nov<")).toBeLessThan(out.indexOf("to you, cc Ben"));
    expect(out.indexOf("to you, cc Ben")).toBeLessThan(out.indexOf("Thursday?"));
  });

  test("a message later in a run has no head and no line", () => {
    const out = html(createElement(MessageEntry, { entry: message(), source: "slack", first: false, when: "10:12 AM", line: "to you" }));
    expect(out).not.toContain("Priya Raman");
    expect(out).not.toContain("10:12 AM");
    expect(out).not.toContain("to you");
    expect(out).toContain("Thursday?");
  });

  test("yours in mail has the same head as anyone's, with where it went on the line", () => {
    const out = html(createElement(MessageEntry, { entry: message({ from: "you", who: "You" }), source: "gmail", line: "to billing@northwind.example" }));
    expect(out).toContain('data-row="person"');
    expect(out).toContain(">You<");
    expect(out).toContain("to billing@northwind.example");
  });

  test("a folded entry is one button with the same head and one line, and no body", () => {
    const out = html(createElement(FoldedEntry, { who: "Priya Raman", when: "14 Nov", at: "2026-11-14T08:15:00Z", line: "Can we move it?", onOpen: () => {} }));
    expect(out).toContain('data-row="folded"');
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain(">P<");
    expect(out.indexOf("Priya Raman")).toBeLessThan(out.indexOf(">14 Nov<"));
    expect(out.indexOf(">14 Nov<")).toBeLessThan(out.indexOf("Can we move it?"));
  });

  test("yours in Slack and Jira sits in the run with your picture, as everyone else's does", () => {
    for (const source of ["slack", "jira"] as const) {
      const out = html(createElement(MessageEntry, { entry: message({ from: "you", who: "You", avatar: "https://example.com/me.png" }), source }));
      expect(out).toContain('data-row="person"');
      expect(out).toContain('src="https://example.com/me.png"');
      expect(out).toContain(">You<");
    }
  });
});

describe("Reactions", () => {
  test("yours is marked and pressed; none draws nothing", () => {
    const out = html(createElement(Reactions, { reactions: [thumbs(true), { ...thumbs(false), name: "eyes", emoji: { kind: "emoji", text: "👀" } }] }));
    expect(out.match(/data-mine="true"/g)?.length).toBe(1);
    expect(out).toContain('aria-pressed="true"');
    expect(out).toContain("👍");
    expect(html(createElement(Reactions, { reactions: [] }))).toBe("");
  });
});

describe("ContentParts", () => {
  test("plain text keeps its links; a mail's files are chips with their sizes", () => {
    const out = html(
      createElement(ContentParts, {
        parts: [
          { kind: "text", text: "Agenda at https://example.com/review" },
          { kind: "mail_files", files: [{ name: "invoice-2026-11.pdf", size: 86_000 }] },
        ],
        source: "gmail",
        title: "Northwind's message",
      }),
    );
    expect(out).toContain('href="https://example.com/review"');
    expect(out).toContain("invoice-2026-11.pdf");
  });

  test("Slack's blocks draw a quote as a quote", () => {
    const out = html(
      createElement(ContentParts, {
        parts: [{ kind: "blocks", blocks: [{ kind: "quote", spans: [{ kind: "text", text: "after 2pm" }] }] }],
        source: "slack",
        title: "x",
      }),
    );
    expect(out).toContain("<blockquote");
    expect(out).toContain("after 2pm");
  });

  test("a Slack message keeps its line breaks", () => {
    const out = html(
      createElement(ContentParts, {
        parts: [{ kind: "blocks", blocks: [{ kind: "text", spans: [{ kind: "text", text: "1. Ledger views\n2. GST summary views" }] }] }],
        source: "slack",
        title: "x",
      }),
    );
    expect(out).toMatch(/class="whitespace-pre-wrap"><div>1\. Ledger views\n2\. GST summary views/);
  });
});

describe("events", () => {
  test("a finished compaction is a checkpoint with no restore", () => {
    const row: TranscriptRow = { role: "event", text: COMPACTED_TEXT, summary: null, detail: "Earlier turns: the chart." };
    const out = html(createElement(EventEntry, { row, arrived: false }));
    expect(out).toContain("data-checkpoint");
    expect(out).toContain(COMPACTED_TEXT);
    expect(out).not.toContain("restore");
  });

  test("an outside change names who made it", () => {
    const out = html(createElement(ChangeEntry, { who: "Sam", text: "status To do → In progress", at: "" }));
    expect(out).toContain("Sam");
    expect(out).toContain("status To do → In progress");
  });
});

describe("a chat's queued message", () => {
  const queued: TranscriptRow = { role: "user", text: "Also add week 14.", queued: true };
  test("offers Take Back when it can be cancelled, and only then", () => {
    expect(html(createElement(ChatMessage, { row: queued, last: true, streaming: false, arrived: false, onCancelQueued: () => {} }))).toContain("Take Back");
    expect(html(createElement(ChatMessage, { row: queued, last: true, streaming: false, arrived: false }))).not.toContain("Take Back");
  });
});
