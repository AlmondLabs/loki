import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AdvisorAnswerRow, OpenAdvisor, type TranscriptRow } from "../app/src/chat/transcript.tsx";
import { EventEntry } from "../app/src/item/event-entry.tsx";

const answered: TranscriptRow = {
  role: "event",
  text: "From the advisor · you asked",
  summary: "The test sleeps.\nIt waits for a lock.\nThe CI box is slower.…",
  detail: "The test sleeps.\n\nIt waits for a lock.\nThe CI box is slower.\n\n**Use the injected clock.**",
  advisor_chat: "advisor-data",
};

const failed: TranscriptRow = {
  role: "event",
  text: "From the advisor · the agent asked",
  summary: "The advisor couldn't answer: loki restarted",
  detail: null,
  advisor_chat: "advisor-data",
};

const opening = (open: ((advisorChat: string) => void) | null, row: TranscriptRow) =>
  renderToStaticMarkup(createElement(OpenAdvisor.Provider, { value: open }, createElement(AdvisorAnswerRow, { row })));

describe("an advisor's answer row (R16, R24)", () => {
  test("names the advisor and who asked, shows the first lines and offers the whole answer", () => {
    const html = opening(null, answered);
    expect(html).toMatch(/role="group" aria-labelledby="([^"]+)".*id="\1">From the advisor · you asked</);
    expect(html).toContain("The test sleeps.\nIt waits for a lock.\nThe CI box is slower.…");
    expect(html).toMatch(/aria-expanded="false"[^>]*>Show More</);
    expect(html).not.toContain("Use the injected clock");
  });

  test("offers to open the advisor chat only where something can open it", () => {
    expect(opening(null, answered)).not.toContain("Open Advisor");
    const html = opening(() => {}, answered);
    expect(html).toMatch(/<button[^>]*title="Open the advisor chat"[^>]*>Open Advisor<\/button>/);
  });

  test("a failure row says why, in words, with nothing more to show", () => {
    const html = opening(() => {}, failed);
    expect(html).toContain("From the advisor · the agent asked");
    expect(html).toContain("The advisor couldn&#x27;t answer: loki restarted");
    expect(html).not.toContain("Show More");
    expect(html).toContain("Open Advisor");
  });

  test("the Mac's thread shows the same row", () => {
    const html = renderToStaticMarkup(createElement(OpenAdvisor.Provider, { value: () => {} }, createElement(EventEntry, { row: answered, arrived: false })));
    expect(html).toContain("From the advisor · you asked");
    expect(html).toContain("Open Advisor");
    expect(html).toContain("Show More");
  });
});
