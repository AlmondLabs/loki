import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TranscriptRow } from "../core/attention/transcript.ts";
import { COMPACTED_TEXT } from "../core/attention/thread.ts";
import type { SlackReaction } from "../core/frame-types.ts";
import { ChatMessage, MessageEntry } from "../app/src/item/message-entry.tsx";
import { ContentParts, WidgetArtifact } from "../app/src/item/content-parts.tsx";
import { Reactions } from "../app/src/item/reactions.tsx";
import { ChangeEntry, EventEntry } from "../app/src/item/event-entry.tsx";
import type { ItemEntry } from "../app/src/item/item-view.ts";
import type { WidgetMark } from "../app/src/chat/transcript.tsx";

// Plan 097, U3: the Timeline's entries, rendered without a browser. Pressing things is checked by hand in the app.

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

const widget = (over: Partial<WidgetMark> = {}): WidgetMark => ({
  id: "w1",
  before: 0,
  at: "2026-11-11T14:49:00Z",
  who: "friday",
  change: "added",
  title: "Signups chart",
  widgetId: "chart",
  gone: false,
  ...over,
});

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

  test("yours is the block with where it went", () => {
    const out = html(createElement(MessageEntry, { entry: message({ from: "you", who: "You" }), source: "gmail", status: "to billing@northwind.example" }));
    expect(out).toContain('data-row="user"');
    expect(out).toContain("· to billing@northwind.example");
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
});

describe("WidgetArtifact", () => {
  test("a widget is a framed artifact titled by the widget, with who changed it and a way to the canvas", () => {
    const out = html(createElement(WidgetArtifact, { mark: widget(), live: false, onFrame: () => {} }));
    expect(out).toContain("Signups chart");
    expect(out).toContain("friday added");
    expect(out).toContain("Show it on the canvas");
  });

  test("a removed widget says so and offers no way to it; earlier changes are one line", () => {
    const gone = html(createElement(WidgetArtifact, { mark: widget({ gone: true }), live: false, onFrame: () => {} }));
    expect(gone).toContain("since removed from the canvas");
    expect(gone).not.toContain("Show it on the canvas");
    expect(html(createElement(WidgetArtifact, { mark: widget({ earlier: 3 }), live: false }))).toContain("3 earlier widget changes");
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
