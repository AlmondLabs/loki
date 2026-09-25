import { afterEach, describe, expect, test } from "bun:test";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Transcript } from "../app/src/chat/Transcript.tsx";
import { CHUNK, WINDOW, anchorTop, findStart, keepStart, openStart, revealStart, threadId } from "../app/src/chat/transcriptWindow.ts";
import { clockLabel, dayLabel, formattersBuilt } from "../app/src/shared/thread.ts";
import { applyEvent, emptyLive, finishCommand, beginCommand, liveRows } from "../core/attention/model.ts";
import type { TranscriptRow } from "../core/attention/transcript.ts";

/**
 * A long thread mounts only its newest rows (perf round 2): the window's arithmetic as pure functions, the
 * New line kept inside it, find reaching past it, the streaming flag on the last row only, live rows that
 * keep their identity between updates, and the clock and day formatters built once.
 */

const T0 = Date.parse("2026-09-20T08:00:00Z");
const thread = (n: number): TranscriptRow[] =>
  Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `message ${i}`, at: new Date(T0 + i * 60_000).toISOString() }) as TranscriptRow);
const people = { user: { name: "You" }, assistant: { name: "ira" } };
const rowsIn = (html: string) => html.match(/data-row="(user|assistant|tool|event)"/g)?.length ?? 0;

describe("the transcript window", () => {
  test("a 420-row thread opens on its newest WINDOW rows, and a short one on all of them", () => {
    expect(WINDOW).toBeLessThanOrEqual(60);
    expect(openStart(420)).toBe(420 - WINDOW);
    expect(openStart(30)).toBe(0);
    const rows = thread(420);
    const html = renderToStaticMarkup(createElement(Transcript, { rows, people, from: openStart(rows.length) }));
    expect(rowsIn(html)).toBe(WINDOW);
    expect(html).toContain("message 419");
    expect(html).not.toContain("message 0<");
  });

  test("scrolling near the top reveals the next chunk, down to the first row", () => {
    expect(revealStart(360)).toBe(360 - CHUNK);
    expect(revealStart(10)).toBe(0);
    expect(revealStart(0)).toBe(0);
    const rows = thread(420);
    const html = renderToStaticMarkup(createElement(Transcript, { rows, people, from: revealStart(openStart(rows.length)) }));
    expect(rowsIn(html)).toBe(WINDOW + CHUNK);
  });

  test("the scroll offset moves by what was added above, so the row being read stays put", () => {
    expect(anchorTop(40, 5000, 8200)).toBe(3240);
    expect(anchorTop(0, 5000, 5000)).toBe(0);
  });

  test("the window keeps its start as rows arrive, and a shorter thread still shows its newest rows", () => {
    expect(keepStart(300, 421, null)).toBe(300);
    expect(keepStart(360, 30, null)).toBe(0);
    expect(keepStart(360, 420, 100)).toBeLessThanOrEqual(100);
  });

  test("another thread is another window: the first row names the thread", () => {
    const a = thread(3);
    expect(threadId(a)).toBe(threadId([...a, { role: "user", text: "more" }]));
    expect(threadId(a)).not.toBe(threadId([{ role: "user", text: "elsewhere" }, ...a]));
    expect(threadId(undefined)).toBe("");
  });
});

describe("the New line with a window", () => {
  test("an unread row older than the window pulls the window up to it, so the line is drawn", () => {
    const rows = thread(420);
    const dividerAt = 120;
    const from = openStart(rows.length, dividerAt);
    expect(from).toBeLessThanOrEqual(dividerAt);
    const html = renderToStaticMarkup(createElement(Transcript, { rows, people, dividerAt, from }));
    expect(html).toContain("loki-msg-divider-new");
    // the window without the pull would have left it out
    expect(renderToStaticMarkup(createElement(Transcript, { rows, people, dividerAt, from: openStart(rows.length) }))).not.toContain("loki-msg-divider-new");
  });
});

describe("find with a window", () => {
  test("a word only an old row holds moves the window's start to that row", () => {
    const rows = thread(420);
    rows[12] = { ...rows[12], text: "the **zebra** crossing" };
    const start = openStart(rows.length);
    expect(findStart(rows, start, "zebra")).toBe(12);
    expect(findStart(rows, start, "Zebra crossing")).toBe(12); // case and markdown do not hide it
    expect(findStart(rows, start, "message 419")).toBe(start); // already in the window
    expect(findStart(rows, start, "nowhere at all")).toBe(start);
    expect(findStart(rows, start, "  ")).toBe(start);
    const html = renderToStaticMarkup(createElement(Transcript, { rows, people, from: findStart(rows, start, "zebra") }));
    expect(html).toContain("zebra");
  });

  test("an event's summary and a widget row's title are found too", () => {
    const rows = thread(200);
    rows[5] = { role: "event", text: "desk activity", summary: "the aardvark widget changed" };
    expect(findStart(rows, 140, "aardvark")).toBe(5);
    expect(findStart(rows, 140, "okapi", [{ before: 9, who: "ira", change: "added", title: "Okapi chart" }])).toBe(9);
  });
});

/** The Row elements a Transcript render hands down (Transcript itself calls no hooks, so its body runs bare). */
function rowElements(props: Parameters<typeof Transcript>[0]): Array<ReactElement<Record<string, unknown>>> {
  const inner = (Transcript as unknown as { type: (p: typeof props) => ReactNode }).type;
  const out: Array<ReactElement<Record<string, unknown>>> = [];
  const walk = (n: ReactNode) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isValidElement(n)) return;
    const p = n.props as Record<string, unknown>;
    if ("row" in p && "streaming" in p) out.push(n as ReactElement<Record<string, unknown>>);
    walk(p.children as ReactNode);
  };
  walk(inner(props));
  return out;
}

describe("streaming touches only the tail", () => {
  test("only the last row is told the thread is streaming", () => {
    const rows = thread(12);
    for (const layout of [{}, { people }]) {
      const els = rowElements({ rows, streaming: true, ...layout });
      expect(els.length).toBe(12);
      expect(els.map((e) => e.props.streaming)).toEqual([...Array(11).fill(false), true]);
    }
  });

  test("across a streaming update every settled row gets the same props, so its memo holds", () => {
    const settled = thread(40);
    const a = rowElements({ rows: [...settled, { role: "assistant", text: "Let" }], streaming: true, people });
    const b = rowElements({ rows: [...settled, { role: "assistant", text: "Let me" }], streaming: true, people });
    for (let i = 0; i < settled.length; i++) {
      const pa = a[i].props;
      const pb = b[i].props;
      for (const k of new Set([...Object.keys(pa), ...Object.keys(pb)])) expect([i, k, pb[k]]).toEqual([i, k, pa[k]]);
      expect(pb.row).toBe(pa.row);
    }
  });

  test("live rows keep their identity between updates; a row that changed is a new object", () => {
    const rt = { agent_id: "a", conversation_id: "c" };
    const delta = (message_type: string, extra: Record<string, unknown> = {}) => ({ type: "stream_delta", runtime: rt, delta: { message_type, ...extra } });
    const l = emptyLive();
    applyEvent(l, delta("user_message", { content: "go" }), "2026-09-23T09:00:00.000Z");
    beginCommand(l, "/reload", "2026-09-23T09:00:01.000Z");
    applyEvent(l, delta("assistant_message", { content: "Let " }), "2026-09-23T09:00:02.000Z");
    const first = liveRows(l);
    applyEvent(l, delta("assistant_message", { content: "me" }), "2026-09-23T09:00:03.000Z");
    const second = liveRows(l);
    expect(second.length).toBe(3);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(second[2]).not.toBe(first[2]);
    expect(second[2].text).toBe("Let me");
    expect(liveRows(l)[2]).toBe(second[2]); // nothing new: the same streaming row
    // the command's row is finished in place: its snapshot is new, the others stay
    finishCommand(l, "/reload", true, "reloaded");
    const third = liveRows(l);
    expect(third[0]).toBe(first[0]);
    expect(third[1]).not.toBe(first[1]);
    expect(third[1].summary).toBe("reloaded");
  });
});

describe("the clock and day formatters", () => {
  const Real = Intl.DateTimeFormat;
  afterEach(() => {
    Intl.DateTimeFormat = Real;
  });
  test("are built once, not per message", () => {
    let built = 0;
    const Counting = function (this: unknown, ...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
      built++;
      return new Real(...args);
    } as unknown as typeof Intl.DateTimeFormat;
    Counting.supportedLocalesOf = Real.supportedLocalesOf;
    Intl.DateTimeFormat = Counting;
    const now = Date.parse("2026-09-23T12:00:00Z");
    const first = { clock: clockLabel(new Date(now).toISOString()), week: dayLabel("2026-09-20T12:00:00Z", now), month: dayLabel("2026-08-03T12:00:00Z", now), year: dayLabel("2025-01-02T12:00:00Z", now) };
    const once = built;
    for (let i = 0; i < 200; i++) {
      clockLabel(new Date(now - i * 60_000).toISOString());
      dayLabel(new Date(now - i * 86_400_000).toISOString(), now);
    }
    expect(built).toBe(once);
    // one per locale and options in use (a clock, a weekday, a date, a dated year), however many messages
    expect(formattersBuilt()).toBeGreaterThan(0);
    expect(formattersBuilt()).toBeLessThanOrEqual(4);
    expect(first.clock).toBe(new Date(now).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
    expect(first.week).toBe(new Date("2026-09-20T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long" }));
    expect(first.month).toBe(new Date("2026-08-03T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }));
    expect(first.year).toBe(new Date("2025-01-02T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }));
  });
});
