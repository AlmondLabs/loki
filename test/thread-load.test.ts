import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Thread } from "../app/src/chat/conversation.tsx";
import { StepDetail, StepsLoad } from "../app/src/chat/tool-steps.tsx";
import type { TranscriptRow } from "../core/attention/transcript.ts";

/** The thread's words for a chat whose first page has not come, did not come, or came empty (plan 041). */
describe("a thread before its first page", () => {
  const html = (props: Parameters<typeof Thread>[0]) => renderToStaticMarkup(createElement(Thread, props));

  test("loading says from which Mac; a page that did not come says so with a way to try again, never 'nothing here yet'", () => {
    expect(html({ rows: undefined })).toContain("loading the thread…");
    expect(html({ rows: undefined, home: "Demo Mini" })).toContain("loading from Demo Mini…");
    const failed = html({ rows: undefined, home: "Demo Mini", loadFailed: () => {} });
    expect(failed).toContain("could not load this chat from Demo Mini");
    expect(failed).toContain("try again");
    expect(failed).not.toContain("nothing here yet");
    expect(html({ rows: [], agentName: "Wren" })).toContain("nothing here yet");
  });
});

describe("a lean step, opened (plan 041)", () => {
  const lean: TranscriptRow = { role: "tool", text: "Bash · ls", tool: { name: "Bash", id: "t1", row: 8 } };
  const shown = (row: TranscriptRow, load: ((n: number) => Promise<null>) | null) =>
    renderToStaticMarkup(createElement(StepsLoad.Provider, { value: load }, createElement(StepDetail, { row })));

  test("waits for its whole step where it can be fetched; a whole row, or one with nothing to fetch it, shows what it has", () => {
    expect(shown(lean, () => Promise.resolve(null))).toContain("Loading this step…");
    expect(shown(lean, null)).toContain("No input or output was recorded");
    const whole: TranscriptRow = { role: "tool", text: "Bash · ls", tool: { name: "Bash", input: "ls", output: "a.ts" } };
    expect(shown(whole, () => Promise.resolve(null))).toContain("a.ts");
  });
});
