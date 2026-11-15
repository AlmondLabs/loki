import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ThreadAnnouncer, threadAnnouncement } from "../app/src/chat/thread-announcer.tsx";
import type { TranscriptRow } from "../core/attention/transcript.ts";

// Plan 2026-11-15-2355 KTD1: the thread says, to a screen reader, when the agent thinks, waits on you or replies.

const row = (role: TranscriptRow["role"], text: string): TranscriptRow => ({ role, text });
const said = (over: Partial<Parameters<typeof threadAnnouncement>[0]>) =>
  threadAnnouncement({ status: "idle", waiting: false, rows: [], who: "atlas", ...over });

describe("what the thread says to a screen reader", () => {
  test("while a turn runs, the agent is thinking, whatever it has streamed so far", () => {
    expect(said({ status: "thinking" })).toBe("Atlas is thinking");
    expect(said({ status: "streaming", rows: [row("user", "hi"), row("assistant", "Hel")] })).toBe("Atlas is thinking");
  });

  test("a question or an approval waiting says so first", () => {
    expect(said({ status: "thinking", waiting: true })).toBe("Atlas is waiting for you");
  });

  test("once the turn ends, the opening of the reply, its spacing made one line", () => {
    expect(said({ rows: [row("user", "hi"), row("assistant", "Done.\n\nThe tests  pass.")] })).toBe("Atlas replied: Done. The tests pass.");
  });

  test("only the words the thread shows: no quick replies, no Markdown marks, a link as its words", () => {
    const text = "## Done\n\nSee **the [diff](https://x.test/d)** in `main.ts`.\n<loki-replies>\n- merge it\n</loki-replies>";
    expect(said({ rows: [row("assistant", text)] })).toBe("Atlas replied: Done See the diff in main.ts.");
  });

  test("a long reply is cut at its opening, with an ellipsis", () => {
    const out = said({ rows: [row("assistant", "word ".repeat(80))] });
    expect(out.length).toBeLessThanOrEqual("Atlas replied: ".length + 160);
    expect(out.endsWith("…")).toBe(true);
  });

  test("nothing when the last row is yours or a step", () => {
    expect(said({ rows: [row("assistant", "ok"), row("user", "thanks")] })).toBe("");
    expect(said({ rows: [row("tool", "read file")] })).toBe("");
  });

  test("the region is always there, polite and read whole", () => {
    const html = renderToStaticMarkup(createElement(ThreadAnnouncer, { status: "idle", waiting: false, rows: [], who: "the agent" }));
    expect(html).toBe('<div class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>');
  });
});
