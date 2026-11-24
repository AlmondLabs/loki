import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CommandRow, OpenChat, type TranscriptRow } from "../app/src/chat/transcript.tsx";
import { EventEntry } from "../app/src/item/event-entry.tsx";

const mac = (row: TranscriptRow, open: ((agentId: string, chatId: string) => void) | null = null) =>
  renderToStaticMarkup(createElement(OpenChat.Provider, { value: open }, createElement(EventEntry, { row, arrived: false })));
const command = (row: Partial<TranscriptRow>) =>
  renderToStaticMarkup(createElement(CommandRow, { row: { role: "event", text: "/compact", event: "command", ...row } }));

describe("your commands are yours (plan 2026-11-24-1736, R5)", () => {
  test("a running command says so, with a mark that stays still for reduced motion", () => {
    const html = command({ summary: "Running" });
    expect(html).toContain("/compact");
    expect(html).toContain("Running");
    expect(html).toContain("motion-reduce:animate-none");
    expect(html).toContain("ml-auto");
  });

  test("a failure reads Failed with why, in the negative colour", () => {
    const html = command({ summary: "Failed: a review is already running" });
    expect(html).toContain("text-loki-negative");
    expect(html).toContain("Failed: a review is already running");
  });

  test("output opens from a button that says it expands; a result with nothing more has none", () => {
    expect(command({ summary: "Done" })).not.toContain("aria-expanded");
    expect(command({ summary: "Done", detail: "line one\nline two" })).toMatch(/<button[^>]*aria-expanded="false"[^>]*>Show Output</);
  });
});

describe("the canvas, another chat and a move, each in its own look (plan 2026-11-24-1736, R2, R6, R8)", () => {
  test("canvas gestures are one widget line that opens to the list", () => {
    const html = mac({ role: "event", text: "You moved 2 widgets", summary: null, detail: 'moved "A" (c/a) to (1, 2)', event: "canvas" });
    expect(html).toMatch(/<button[^>]*aria-expanded="false"/);
    expect(html).toContain("You moved 2 widgets");
    expect(html).not.toContain("moved &quot;A&quot;");
  });

  test("a message from another chat is one line, and Open Chat is not part of the line that opens it", () => {
    const row: TranscriptRow = {
      role: "event",
      text: "From Data pipeline",
      summary: "The import is done.",
      detail: "The import is done.\nRows: 12",
      link: { agent_id: "friday", conversation_id: "data" },
      event: "chat_message",
    };
    const html = mac(row, () => {});
    expect(html).toContain("From Data pipeline");
    expect(html).toMatch(/<button[^>]*aria-expanded="false"/);
    expect(html).not.toContain("Open Chat");
  });

  test("a move is a separator that says where the chat went", () => {
    const html = mac({ role: "event", text: "Moved to Studio", summary: "from MacBook Pro", event: "moved" });
    expect(html).toMatch(/role="separator"[^>]*aria-label="Moved to Studio · from MacBook Pro"/);
  });
});
