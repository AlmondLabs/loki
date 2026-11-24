import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AdvisorAnswerRow, OpenAdvisor, type TranscriptRow } from "../app/src/chat/transcript.tsx";
import { EventEntry } from "../app/src/item/event-entry.tsx";

const answered: TranscriptRow = {
  role: "event",
  text: "Advisor answered · the agent asked",
  summary: "The runner follows the plan.",
  detail: "**The runner follows the plan.**\n### High\n1. Cleanup can leak.",
  advisor_chat: "advisor-data",
  event: "advisor",
};

const failed: TranscriptRow = {
  role: "event",
  text: "Advisor couldn't answer · you asked",
  summary: "loki restarted",
  detail: null,
  advisor_chat: "advisor-data",
  event: "advisor",
};

const opening = (open: ((advisorChat: string) => void) | null, row: TranscriptRow) =>
  renderToStaticMarkup(createElement(OpenAdvisor.Provider, { value: open }, createElement(AdvisorAnswerRow, { row })));

describe("an advisor's answer is one line (plan 2026-11-24-1736, R1)", () => {
  test("it says the advisor answered, who asked and its verdict, in one line, and nothing of the rest", () => {
    const html = opening(null, answered);
    expect(html).toContain("Advisor answered · the agent asked");
    expect(html).toContain("The runner follows the plan.");
    expect(html).toContain("truncate");
    expect(html).not.toContain("Cleanup can leak");
    expect(html).not.toContain("Show More");
  });

  test("the line opens the advisor chat where something can open it, and is no button where nothing can", () => {
    expect(opening(null, answered)).not.toContain("<button");
    let opened = "";
    const html = opening((chat) => (opened = chat), answered);
    expect(html).toMatch(/<button[^>]*title="Open the advisor chat"/);
    expect(opened).toBe("");
  });

  test("a failure says why", () => {
    const html = opening(() => {}, failed);
    expect(html).toContain("Advisor couldn&#x27;t answer · you asked");
    expect(html).toContain("loki restarted");
    expect(html).not.toContain("Show More");
  });

  test("the Mac's thread draws the same line", () => {
    const html = renderToStaticMarkup(createElement(OpenAdvisor.Provider, { value: () => {} }, createElement(EventEntry, { row: answered, arrived: false })));
    expect(html).toContain("Advisor answered · the agent asked");
    expect(html).toMatch(/<button[^>]*title="Open the advisor chat"/);
    expect(html).not.toContain("Show More");
  });
});
