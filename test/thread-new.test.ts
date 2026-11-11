import { afterEach, describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TranscriptRow } from "../core/attention/transcript.ts";
import { threadEntries, threadTurns, type EntryInput, type ThreadEntry } from "../app/src/item/entries.ts";
import { AgentTurn } from "../app/src/item/agent-turn.tsx";
import { Work } from "../app/src/item/work.tsx";
import { ChatMessage } from "../app/src/item/message-entry.tsx";
import { NewMarker } from "../app/src/item/event-entry.tsx";
import { WidgetArtifact } from "../app/src/item/content-parts.tsx";
import { Thread } from "../app/src/chat/conversation.tsx";
import { threadPreview } from "../app/src/item/preview.ts";
import type { WidgetMark } from "../app/src/chat/transcript.tsx";

// Plan 096, U5: the new thread on shadcn. Its reading order is a pure function (entries.ts); its pieces render without a
// browser. Scrolling, following and anchoring are MessageScroller's and are checked by hand in the app.

const NOW = Date.parse("2026-11-11T15:00:00Z");
const user = (text: string, at?: string): TranscriptRow => ({ role: "user", text, ...(at ? { at } : {}) });
const agent = (text: string, at?: string): TranscriptRow => ({ role: "assistant", text, ...(at ? { at } : {}) });
const bash = (failed = false, output = "ok"): TranscriptRow => ({
  role: "tool",
  text: "Bash · ls",
  tool: { name: "Bash", output, ...(failed ? { failed: true } : {}) },
});
const read = (): TranscriptRow => ({ role: "tool", text: "Read · a.ts", tool: { name: "Read", output: "…" } });
const mark = (id: string, before: number, at: string, extra: Partial<WidgetMark> = {}): WidgetMark => ({
  id,
  before,
  at,
  who: "friday",
  change: "added",
  title: "Signups chart",
  widgetId: "chart",
  gone: false,
  ...extra,
});
const input = (rows: TranscriptRow[], extra: Partial<EntryInput> = {}): EntryInput => ({
  rows,
  from: 0,
  above: 0,
  dividerAt: null,
  dividerDay: null,
  widgets: [],
  busy: false,
  arrivedFrom: Infinity,
  now: NOW,
  ...extra,
});
const kinds = (entries: ThreadEntry[]) => entries.map((e) => (e.kind === "message" ? `${e.row.role}${e.first ? "*" : ""}` : e.kind));

describe("the new thread's reading order", () => {
  test("messages, a stretch of work as one entry, and who opens a run", () => {
    const rows = [user("chart signups"), agent("on it"), bash(), read(), agent("done"), agent("anything else?")];
    const entries = threadEntries(input(rows));
    expect(kinds(entries)).toEqual(["user*", "assistant*", "steps", "assistant", "assistant"]);
    const steps = entries[2];
    expect(steps.kind === "steps" && steps.rows).toHaveLength(2);
  });

  test("a day marker opens each calendar day when rows carry times, and the New line sits before its row", () => {
    const rows = [
      user("yesterday", "2026-11-10T09:00:00Z"),
      agent("hi", "2026-11-10T09:01:00Z"),
      user("today", "2026-11-11T09:00:00Z"),
      agent("again", "2026-11-11T09:01:00Z"),
    ];
    const entries = threadEntries(input(rows, { dividerAt: 3, dividerDay: "Today" }));
    expect(kinds(entries)).toEqual(["day", "user*", "assistant*", "day", "user*", "new", "assistant*"]);
    const nl = entries.find((e) => e.kind === "new");
    // With times, the day markers name the day; the New line does not.
    expect(nl?.kind === "new" && nl.day).toBeNull();
  });

  test("without times the New line names the day it was given", () => {
    const entries = threadEntries(input([user("a"), agent("b")], { dividerAt: 1, dividerDay: "Today" }));
    const nl = entries.find((e) => e.kind === "new");
    expect(nl?.kind === "new" && nl.day).toBe("Today");
  });

  test("a widget change sits before its row and only the latest of a widget is drawn live", () => {
    const rows = [user("make a chart", "2026-11-11T09:00:00Z"), agent("added", "2026-11-11T09:02:00Z"), agent("changed it", "2026-11-11T09:05:00Z")];
    const widgets = [mark("one", 1, "2026-11-11T09:01:00Z"), mark("two", 2, "2026-11-11T09:04:00Z", { change: "changed" })];
    const entries = threadEntries(input(rows, { widgets }));
    const marks = entries.flatMap((e) => (e.kind === "widget" ? [[e.mark.id, e.live]] : []));
    expect(marks).toEqual([
      ["one", false],
      ["two", true],
    ]);
    // A widget row breaks the run: the agent's message after it is named again.
    expect(kinds(entries)).toEqual(["day", "user*", "widget", "assistant*", "widget", "assistant*"]);
  });

  test("the window: rows before `from` are not drawn, and keys count past the rows loaded above", () => {
    const rows = [user("old"), agent("old reply"), user("new"), agent("new reply")];
    const entries = threadEntries(input(rows, { from: 2, above: 2 }));
    expect(entries.map((e) => e.key)).toEqual(["r-0", "r-1"]);
  });

  test("a last stretch still waiting on its result runs only while the agent works", () => {
    const rows = [user("go"), bash(false, "")];
    const quiet = threadEntries(input(rows))[1];
    const busy = threadEntries(input(rows, { busy: true }))[1];
    expect(quiet.kind === "steps" && quiet.running).toBe(false);
    expect(busy.kind === "steps" && busy.running).toBe(true);
  });

  test("rows past arrivedFrom rise in", () => {
    const entries = threadEntries(input([user("a"), agent("b"), user("c")], { arrivedFrom: 2 }));
    expect(entries.map((e) => e.kind === "message" && e.arrived)).toEqual([false, false, true]);
  });
});

describe("turns: everything the agent did between two of your messages", () => {
  const turnKinds = (rows: TranscriptRow[], o = { busy: false, waiting: false }, extra: Partial<EntryInput> = {}) =>
    threadTurns(threadEntries(input(rows, extra)), o).map((e) =>
      e.kind === "turn" ? `turn(${e.parts.map((p) => p.kind).join(",")}):${e.state}` : e.kind === "message" ? e.row.role : e.kind,
    );

  test("the agent's words and work between your messages are one turn", () => {
    expect(turnKinds([user("go"), agent("on it"), bash(), agent("done"), user("thanks"), agent("welcome")])).toEqual([
      "user",
      "turn(message,steps,message):done",
      "user",
      "turn(message):done",
    ]);
  });

  test("a turn with a failed step says how many failed", () => {
    const [, turn] = threadTurns(threadEntries(input([user("go"), bash(true), bash(true), agent("sorry")])), { busy: false, waiting: false });
    expect(turn.kind === "turn" && [turn.state, turn.failed]).toEqual(["failed", 2]);
  });

  test("only the last turn works or waits on you", () => {
    const rows = [user("a"), agent("b"), user("c"), agent("d")];
    expect(turnKinds(rows, { busy: true, waiting: false })).toEqual(["user", "turn(message):done", "user", "turn(message):working"]);
    expect(turnKinds(rows, { busy: true, waiting: true })).toEqual(["user", "turn(message):done", "user", "turn(message):needs you"]);
  });

  test("a day or the New line ends a turn, and a turn keeps its key as it grows", () => {
    expect(turnKinds([user("a"), agent("b"), agent("c")], undefined, { dividerAt: 2 })).toEqual(["user", "turn(message):done", "new", "turn(message):done"]);
    const short = threadTurns(threadEntries(input([user("a"), agent("b")])), { busy: false, waiting: false });
    const long = threadTurns(threadEntries(input([user("a"), agent("b"), bash()])), { busy: false, waiting: false });
    expect(short[1].key).toBe(long[1].key);
  });

  test("how long a turn took comes from the times on its rows", () => {
    const rows = [user("a", "2026-11-11T09:00:00Z"), agent("b", "2026-11-11T09:01:00Z"), agent("c", "2026-11-11T09:05:00Z")];
    const turn = threadTurns(threadEntries(input(rows)), { busy: false, waiting: false }).find((e) => e.kind === "turn");
    expect(turn?.kind === "turn" && turn.took).toBe("4 min");
  });
});

describe("the new thread's pieces", () => {
  test("a stretch of work is one closed line in today's wording, with the failed step named under it", () => {
    const html = renderToStaticMarkup(createElement(Work, { rows: [bash(), bash(true)], running: false, arrived: false }));
    expect(html).toContain("Ran 2 commands · 1 failed");
    expect(html).toContain("ls failed");
    expect(html).toContain('data-row="tool"');
  });

  test("a running stretch shimmers and names no failure", () => {
    const html = renderToStaticMarkup(createElement(Work, { rows: [bash(), bash(true, "")], running: true, arrived: false }));
    expect(html).toContain("Working");
    expect(html).toContain("shimmer");
    expect(html).not.toContain("failed</button>");
  });

  test("your message is a block labelled You with its time and copy; the agent's words carry their copy and time", () => {
    const mine = renderToStaticMarkup(
      createElement(ChatMessage, { row: user("hello", "2026-11-11T09:00:00Z"), last: false, streaming: false, arrived: false }),
    );
    expect(mine).toContain('data-row="user"');
    expect(mine).toContain(">You<");
    expect(mine).toContain("copy as markdown");
    const theirs = renderToStaticMarkup(createElement(ChatMessage, { row: agent("hi", "2026-11-11T09:01:00Z"), last: true, streaming: false, arrived: false }));
    expect(theirs).toContain('data-row="assistant"');
    expect(theirs).toContain("copy as markdown");
  });

  test("a streaming reply offers no copy until it is done, and a queued message offers its take-back", () => {
    const live = renderToStaticMarkup(createElement(ChatMessage, { row: agent("writing"), last: true, streaming: true, arrived: false }));
    expect(live).not.toContain("copy as markdown");
    const queued = renderToStaticMarkup(
      createElement(ChatMessage, { row: { ...user("later"), queued: true }, last: true, streaming: false, arrived: false, onCancelQueued: () => {} }),
    );
    expect(queued).toContain("queued · sends when this turn ends · take back");
  });

  test("a turn's header names the agent, how long it worked and where it stands", () => {
    const html = renderToStaticMarkup(
      createElement(AgentTurn, { agentName: "friday", state: "failed", failed: 1, took: "4 min", parts: [], draw: () => null }),
    );
    expect(html).toContain("friday");
    expect(html).toContain("worked 4 min");
    expect(html).toContain("1 failed");
    expect(
      renderToStaticMarkup(createElement(AgentTurn, { agentName: "friday", state: "needs you", failed: 0, took: null, parts: [], draw: () => null })),
    ).toContain("needs you");
  });

  test("the New line and a widget row read as today's", () => {
    expect(renderToStaticMarkup(createElement(NewMarker, { day: null }))).toContain("New since you last looked");
    const html = renderToStaticMarkup(createElement(WidgetArtifact, { mark: mark("one", 0, "2026-11-11T09:01:00Z"), live: false, onFrame: () => {} }));
    expect(html).toContain("friday");
    expect(html).toContain("Signups chart");
    expect(html).toContain("<button");
  });
});

describe("the thread seam", () => {
  afterEach(() => threadPreview.set("off"));
  const rows = [user("hello"), agent("hi")];

  test("today's thread by default, the new one when the preview is on", () => {
    expect(renderToStaticMarkup(createElement(Thread, { rows }))).not.toContain("data-new-thread");
    threadPreview.set("on");
    expect(renderToStaticMarkup(createElement(Thread, { rows }))).toContain("data-new-thread");
  });

  test("a host that is not previewable keeps today's thread", () => {
    threadPreview.set("on");
    expect(renderToStaticMarkup(createElement(Thread, { rows, previewable: false }))).not.toContain("data-new-thread");
  });
});
